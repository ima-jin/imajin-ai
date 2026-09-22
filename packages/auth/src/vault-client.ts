/**
 * `loadFromVault` — fetch-at-boot helper for a service to pull its own
 * credentials out of the kernel vault at process start (#2243, child of
 * epic #2241).
 *
 * This module is a thin, generic CLIENT over three existing kernel routes —
 * it introduces no new server-side surface:
 *   - `POST /api/challenge` + `POST /api/authenticate` — the existing
 *     DID challenge-response dance (`app/auth/api/challenge`,
 *     `app/auth/api/authenticate`) used here to turn the caller's OWN
 *     bootstrap keypair into a short-lived bearer token, since
 *     `requireAuth()` on the two routes below only accepts a session
 *     cookie or a Bearer token — never a raw keypair.
 *   - `POST /api/vault/delegation/grants/{grantId}/fetch` (#2231) —
 *     fetches the sealed value behind a one-time delegation grant.
 *   - `POST /api/vault/delegation/grants/{grantId}/ack` (#2235) — signs
 *     what the caller did with a value it already fetched.
 *
 * ## Guarantees
 *  - Memory-only: the fetched value is returned to the caller and never
 *    written to disk, an env var, a log line, or a thrown error message.
 *  - Every key fetch is acked (#2235) with the outcome and the caller's
 *    `purpose` (folded into the ack's free-text `note` — the ack route has
 *    no separate `purpose` field; the grant's `purpose` is set at
 *    grant-issuance time instead). Ack failures are logged as warnings and
 *    never fail the overall `loadFromVault()` call (#2235's ack is a
 *    best-effort signed record, not a precondition for using a secret
 *    already in hand).
 *  - Fail-closed/degraded per key, declared by the caller via
 *    `onMissing: 'fail' | 'degrade'` — a `'fail'` key that cannot be
 *    fetched throws (redacted: the thrown message never contains a fetched
 *    value, a private key, or a bearer token); a `'degrade'` key is simply
 *    omitted from the result's `values`/`dids` and listed in `degraded`.
 *
 * ## What this does NOT do
 *  - It does not decide HOW a caller obtains the bootstrap `identity` it
 *    authenticates with, or the `grant` id(s) it fetches — those are the
 *    caller's own boot-time configuration (see `apps/corpus/src/lib/corpus-identity.ts`
 *    for the first consumer). In particular this module does not implement
 *    the "claimable pending service" self-registration/pairing flow noted
 *    on #2243 and #2241 — see this repo's #2243 PR description for why.
 *  - It authenticates as ONE identity per call and reuses that one bearer
 *    token for every `keys[]` entry — a caller needing to fetch grants
 *    issued to DIFFERENT identities must call `loadFromVault` once per
 *    identity.
 */
import * as crypto from './crypto';
import { createLogger } from '@imajin/logger';

const log = createLogger('auth');

/** Vault field-name prefix for a #2242-minted keypair's sealed private key — mirrors `mintedKeyField()` in `apps/kernel/src/lib/vault/mint.ts`. Duplicated rather than imported: packages/auth must not depend on apps/kernel (same package-boundary rule `require-auth.ts`'s `nodeOrigin()` docblock calls out). */
const MINTED_KEY_FIELD_PREFIX = 'vault-minted-key:';

/** Max length of the free-text `note` the ack route accepts (mirrors the kernel route's own `MAX_NOTE_LENGTH`). */
const MAX_ACK_NOTE_LENGTH = 280;

export interface VaultBootstrapIdentity {
  /** The caller's own, already-registered kernel identity DID. */
  did: string;
  /** That identity's Ed25519 private key, hex-encoded. Held only in memory by the caller. */
  privateKey: string;
}

export interface VaultKeySpec {
  /** Name the caller wants this fetched value keyed under in the result (e.g. an env var name it replaces). */
  key: string;
  /**
   * `'fail'` — `loadFromVault` throws if this key cannot be fetched.
   * `'degrade'` — this key is silently omitted from the result and listed
   * in `degraded`; the caller decides what "missing" means for it (e.g.
   * corpus's existing skip-signing-and-warn-once mode, `corpus-identity.ts`).
   */
  onMissing: 'degrade' | 'fail';
  /**
   * The one-time delegation grant id to fetch THIS key from. Defaults to
   * the top-level `grant` — set this only when a single `loadFromVault`
   * call needs to fetch keys sealed under different grants (e.g. a future
   * multi-key consumer per #1922).
   */
  grant?: string;
}

export interface LoadFromVaultParams {
  /** Default one-time grant id, used for any `keys[]` entry that doesn't set its own `grant`. */
  grant: string;
  /** Why these keys are needed — recorded on each grant's ack (#2235), not logged anywhere else. */
  purpose: string;
  keys: VaultKeySpec[];
  /** The caller's own bootstrap identity, used to authenticate the fetch/ack calls. */
  identity: VaultBootstrapIdentity;
  /** Defaults to `process.env.AUTH_SERVICE_URL`. */
  authServiceUrl?: string;
}

export interface VaultCredentials {
  /** `key` (from `VaultKeySpec.key`) -> fetched value. Absent for any key that degraded. */
  values: Record<string, string>;
  /**
   * `key` -> the DID a minted-keypair value belongs to, derived from the
   * vault field name (`vault-minted-key:<did>`) rather than returned
   * separately by the fetch route. Only present for keys whose underlying
   * vault field was a #2242 minted keypair.
   */
  dids: Record<string, string>;
  /** `key` names that could not be fetched and were declared `onMissing: 'degrade'`. */
  degraded: string[];
}

/** Extracts the DID a #2242-minted keypair's private key belongs to from its vault field name, or `null` for any other field shape. */
function didFromMintedKeyField(field: string): string | null {
  return field.startsWith(MINTED_KEY_FIELD_PREFIX) ? field.slice(MINTED_KEY_FIELD_PREFIX.length) : null;
}

function resolveAuthServiceUrl(explicit: string | undefined): string {
  const url = explicit ?? process.env.AUTH_SERVICE_URL;
  if (!url) {
    throw new Error('loadFromVault: AUTH_SERVICE_URL is not set');
  }
  return url;
}

interface ChallengeResponse {
  challengeId: string;
  challenge: string;
}

/** `POST /api/challenge` — obtain a challenge string for `identity.did` to sign. */
async function requestChallenge(authServiceUrl: string, did: string): Promise<ChallengeResponse> {
  const res = await fetch(`${authServiceUrl}/api/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: did }),
  });
  if (!res.ok) {
    throw new Error(`loadFromVault: failed to obtain an auth challenge (status ${res.status})`);
  }
  const body = (await res.json().catch(() => null)) as Partial<ChallengeResponse> | null;
  if (!body?.challengeId || !body.challenge) {
    throw new Error('loadFromVault: auth challenge response was malformed');
  }
  return { challengeId: body.challengeId, challenge: body.challenge };
}

/** `POST /api/authenticate` — exchange a signed challenge for a short-lived bearer token. */
async function exchangeChallengeForToken(
  authServiceUrl: string,
  identity: VaultBootstrapIdentity,
  challengeId: string,
  challenge: string,
): Promise<string> {
  const signature = crypto.signSync(challenge, identity.privateKey);
  const res = await fetch(`${authServiceUrl}/api/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: identity.did, challengeId, signature }),
  });
  if (!res.ok) {
    // Deliberately no response body in the thrown message — never risk
    // surfacing anything the auth route might echo back.
    throw new Error(`loadFromVault: authentication failed (status ${res.status})`);
  }
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== 'string' || body.token.length === 0) {
    throw new Error('loadFromVault: authentication response was missing a token');
  }
  return body.token;
}

/** Full challenge-response dance: `identity` -> a bearer token usable against `requireAuth()`-gated routes. */
async function authenticateBootstrapIdentity(
  authServiceUrl: string,
  identity: VaultBootstrapIdentity,
): Promise<string> {
  const { challengeId, challenge } = await requestChallenge(authServiceUrl, identity.did);
  return exchangeChallengeForToken(authServiceUrl, identity, challengeId, challenge);
}

type FetchGrantResult =
  | { ok: true; field: string; value: string }
  | { ok: false; status: number; error: string };

/** `POST /api/vault/delegation/grants/{grantId}/fetch` (#2231). Never throws for an ordinary refusal (404/409/410/403) — those come back as `{ ok: false, ... }`. */
async function fetchGrant(authServiceUrl: string, grantId: string, token: string): Promise<FetchGrantResult> {
  const res = await fetch(`${authServiceUrl}/api/vault/delegation/grants/${encodeURIComponent(grantId)}/fetch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as
    | { ok?: unknown; field?: unknown; value?: unknown; error?: unknown }
    | null;

  if (!res.ok || body?.ok !== true || typeof body.field !== 'string' || typeof body.value !== 'string') {
    return {
      ok: false,
      status: res.status,
      error: typeof body?.error === 'string' ? body.error : 'unknown error',
    };
  }
  return { ok: true, field: body.field, value: body.value };
}

/**
 * `POST /api/vault/delegation/grants/{grantId}/ack` (#2235). Never throws —
 * an ack failure is a warning, never a `loadFromVault()` failure (see this
 * module's docblock). `note` carries the caller's `purpose` since the ack
 * route itself has no dedicated `purpose` field.
 */
async function ackGrantBestEffort(
  authServiceUrl: string,
  grantId: string,
  token: string,
  outcome: 'used' | 'failed' | 'discarded',
  note: string,
): Promise<void> {
  try {
    const res = await fetch(`${authServiceUrl}/api/vault/delegation/grants/${encodeURIComponent(grantId)}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ outcome, note: note.slice(0, MAX_ACK_NOTE_LENGTH) }),
    });
    if (!res.ok) {
      log.warn({ grantId, outcome, status: res.status }, 'loadFromVault: ack was rejected — treating as non-fatal per #2235');
    }
  } catch (err) {
    log.warn({ grantId, outcome, err: String(err) }, 'loadFromVault: ack request failed — treating as non-fatal per #2235');
  }
}

/** Fetches (and acks) one `VaultKeySpec`, mutating `result` in place. Throws only for an `onMissing: 'fail'` key. */
async function loadOneKey(
  authServiceUrl: string,
  token: string,
  defaultGrant: string,
  purpose: string,
  keySpec: VaultKeySpec,
  result: VaultCredentials,
): Promise<void> {
  const grantId = keySpec.grant ?? defaultGrant;
  const outcome = await fetchGrant(authServiceUrl, grantId, token);

  if (!outcome.ok) {
    log.warn(
      { key: keySpec.key, status: outcome.status },
      `loadFromVault: could not fetch key '${keySpec.key}'`,
    );
    if (keySpec.onMissing === 'fail') {
      throw new Error(`loadFromVault: required key '${keySpec.key}' could not be fetched from the vault`);
    }
    result.degraded.push(keySpec.key);
    return;
  }

  result.values[keySpec.key] = outcome.value;
  const did = didFromMintedKeyField(outcome.field);
  if (did) {
    result.dids[keySpec.key] = did;
  }

  await ackGrantBestEffort(authServiceUrl, grantId, token, 'used', purpose);
}

/**
 * Fetch `params.keys` through their one-time delegation grant(s), holding
 * every value in memory only. See this module's docblock for the full
 * contract.
 */
export async function loadFromVault(params: LoadFromVaultParams): Promise<VaultCredentials> {
  const authServiceUrl = resolveAuthServiceUrl(params.authServiceUrl);
  const token = await authenticateBootstrapIdentity(authServiceUrl, params.identity);

  const result: VaultCredentials = { values: {}, dids: {}, degraded: [] };
  for (const keySpec of params.keys) {
    await loadOneKey(authServiceUrl, token, params.grant, params.purpose, keySpec, result);
  }
  return result;
}
