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
 *  - Fail-closed/degraded per key, declared by the caller via
 *    `onMissing: 'fail' | 'degrade'` — a `'fail'` key that cannot be
 *    fetched throws (redacted: the thrown message never contains a fetched
 *    value, a private key, or a bearer token); a `'degrade'` key is simply
 *    omitted from the result's `values`/`dids` and listed in `degraded`.
 *
 * ## Ack semantics (#2257 ruling — option (b′), one deferred ack per grant)
 *  `loadFromVault` never acks a key at fetch-time. The kernel's fetch event
 *  (#2231) already records "it left the vault" — a fetch-time ack would
 *  make `outcome: 'failed'` (#2235) unreachable, since the helper would
 *  already have claimed `'used'` before the caller had done anything with
 *  the value. Instead, every key it successfully fetches gets a
 *  `GrantAckHandle` back (`VaultCredentials.acks[key]`) whose ONE job is
 *  reporting what the CALLER did with that value:
 *   - `used(evidenceKind?)` — the caller's own first successful use of the
 *     key. This is the caller's responsibility to call, at the exact
 *     moment of first use — `loadFromVault` has no way to observe "used"
 *     on its own for a caller that uses the value lazily (e.g. corpus only
 *     signs when it next ingests something; see
 *     `apps/corpus/src/lib/corpus-identity.ts`'s `markCorpusIdentityUsedForSigning`).
 *   - `failed(evidenceKind?)` — a boot/startup failure attributable to
 *     this key (it doesn't parse, doesn't look like what the caller
 *     expected, etc.).
 *   - `discarded()` — process shutdown, or an explicit release, without
 *     any use. A caller never has to call this itself: a `beforeExit` /
 *     `SIGTERM` / `SIGINT` safety net (installed once by this module, see
 *     `installExitAckHook` below) sends `'discarded'` for every handle
 *     still un-acked when the process is going down, so a fetched grant
 *     can never be silently left un-acked (the #2247 "fetch-without-ack"
 *     red line).
 *  Each handle sends exactly ONE ack, ever — the first of
 *  `used`/`failed`/`discarded`/the exit hook to fire wins; every later call
 *  on the same handle is a same-process no-op (logged at debug level, no
 *  second HTTP call). Every ack call is best-effort: a rejected or thrown
 *  ack request only logs a warning, and never fails the caller's flow.
 *  `evidenceKind` is a short, value-free label only (e.g. `'first-sign'`)
 *  — never pass secret material or free text that could carry it; this
 *  module never includes a fetched value, a private key, or a bearer
 *  token in an ack request, a log line, or a thrown error message.
 *  This is the pattern for every future consumer (#2245, #2246).
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

/** `outcome` values the ack route accepts (#2235, deferred per #2257). */
export type GrantAckOutcome = 'used' | 'failed' | 'discarded';

/**
 * One-ack-per-grant handle returned for each key `loadFromVault` actually
 * fetched. See this module's docblock ("Ack semantics") for the full
 * contract. Every method is synchronous and never throws — the underlying
 * ack HTTP call is fire-and-forget best-effort, matching #2235's existing
 * "ack is a warning, not a precondition" posture.
 */
export interface GrantAckHandle {
  /** The caller's first successful use of this key. Call this yourself, exactly where "first use" actually happens for your consumer. */
  used(evidenceKind?: string): void;
  /** A boot/startup failure attributable to this key. */
  failed(evidenceKind?: string): void;
  /** Process shutdown / explicit release without any use. Usually unnecessary to call directly — the module-level exit hook does this automatically for any handle still un-acked. */
  discarded(): void;
}

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
  /**
   * `key` -> the one-ack-per-grant handle for a successfully-fetched key
   * (#2257). Absent for any key listed in `degraded` — nothing was fetched
   * for it, so there is nothing to ack (the kernel's fetch route already
   * refused before any grant was consumed).
   */
  acks: Record<string, GrantAckHandle>;
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
 * route itself has no dedicated `purpose` field. `evidenceKind` (when
 * given) is sent as `evidence.kind`; `evidence.ref` is always the grantId
 * itself (never secret, already known to the kernel) since the route
 * requires both fields together — this client never sends any OTHER
 * free-text evidence that could carry secret material.
 */
async function sendGrantAck(
  authServiceUrl: string,
  grantId: string,
  token: string,
  outcome: GrantAckOutcome,
  purpose: string,
  evidenceKind: string | undefined,
): Promise<void> {
  try {
    const res = await fetch(`${authServiceUrl}/api/vault/delegation/grants/${encodeURIComponent(grantId)}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        outcome,
        note: purpose.slice(0, MAX_ACK_NOTE_LENGTH),
        ...(evidenceKind ? { evidence: { kind: evidenceKind, ref: grantId } } : {}),
      }),
    });
    if (!res.ok) {
      log.warn({ grantId, outcome, status: res.status }, 'loadFromVault: ack was rejected — treating as non-fatal per #2235/#2257');
    }
  } catch (err) {
    log.warn({ grantId, outcome, err: String(err) }, 'loadFromVault: ack request failed — treating as non-fatal per #2235/#2257');
  }
}

/**
 * Registry of ack handles that have not yet sent their (single) ack, used
 * only by the exit-time safety net below — a handle removes itself the
 * instant it sends an ack, successful or not. Keyed by an opaque per-handle
 * object identity rather than `grantId` so nothing here needs `grantId` to
 * be globally unique across every `loadFromVault` caller in the process.
 */
const pendingGrantAcks = new Map<object, () => void>();

/** Every event this module's exit safety net listens for (#2257). */
const EXIT_ACK_HOOK_EVENTS = ['beforeExit', 'SIGTERM', 'SIGINT'] as const;

/**
 * Sends `'discarded'` for every grant handle still un-acked. This is the
 * exit-time safety net for #2257's "process shutdown without any use ->
 * discarded" rule: swapped in as the live `process` listener by
 * `installExitAckHook` below, and also exported (as `_flushUnackedGrantsForTests`)
 * so tests can trigger it deterministically without sending the process a
 * real signal.
 */
function flushUnackedGrantsAsDiscarded(): void {
  for (const discard of [...pendingGrantAcks.values()]) {
    discard();
  }
}

/** Test-only: same effect as this process receiving `SIGTERM`/`SIGINT`/`beforeExit`, without touching the real process. */
export function _flushUnackedGrantsForTests(): void {
  flushUnackedGrantsAsDiscarded();
}

/**
 * (Re-)installs this module's process-exit safety net, first removing any
 * listener left behind by a PREVIOUSLY-loaded instance of this module.
 * That swap only matters for tests, which reload this module repeatedly
 * via `vi.resetModules()` — production loads this module exactly once, so
 * this is a one-time no-op in practice. Without the swap, every reload
 * would leave one more set of listeners attached to the real `process`,
 * quickly tripping Node's `MaxListenersExceededWarning`, and only the
 * FIRST-loaded module instance's (stale) `pendingGrantAcks` would ever
 * actually flush.
 */
function installExitAckHook(): void {
  const registry = globalThis as unknown as Record<symbol, (() => void) | undefined>;
  const registryKey = Symbol.for('imajin.auth.vault-client.exitAckHook');
  const previous = registry[registryKey];
  if (previous) {
    for (const event of EXIT_ACK_HOOK_EVENTS) {
      process.removeListener(event, previous);
    }
  }
  for (const event of EXIT_ACK_HOOK_EVENTS) {
    process.on(event, flushUnackedGrantsAsDiscarded);
  }
  registry[registryKey] = flushUnackedGrantsAsDiscarded;
}

installExitAckHook();

/**
 * Builds the one-ack-per-grant handle for a key that was just successfully
 * fetched. Registers itself in `pendingGrantAcks` immediately so the exit
 * safety net covers it even if the caller never touches the handle at all.
 */
function createGrantAckHandle(
  authServiceUrl: string,
  grantId: string,
  token: string,
  purpose: string,
): GrantAckHandle {
  const registryKey: object = {};
  let sent = false;

  const send = (outcome: GrantAckOutcome, evidenceKind?: string): void => {
    if (sent) {
      log.debug({ grantId, outcome }, 'loadFromVault: grant already acked — ignoring extra ack (#2257 one-ack-per-grant)');
      return;
    }
    sent = true;
    pendingGrantAcks.delete(registryKey);
    void sendGrantAck(authServiceUrl, grantId, token, outcome, purpose, evidenceKind);
  };

  pendingGrantAcks.set(registryKey, () => send('discarded'));

  return {
    used: evidenceKind => send('used', evidenceKind),
    failed: evidenceKind => send('failed', evidenceKind),
    discarded: () => send('discarded'),
  };
}

/** Fetches one `VaultKeySpec`, mutating `result` in place. Throws only for an `onMissing: 'fail'` key. No ack is sent here (#2257) — a successful fetch instead gets a deferred `GrantAckHandle` in `result.acks`. */
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

  result.acks[keySpec.key] = createGrantAckHandle(authServiceUrl, grantId, token, purpose);
}

/**
 * Fetch `params.keys` through their one-time delegation grant(s), holding
 * every value in memory only. See this module's docblock for the full
 * contract, including the deferred (#2257) ack semantics.
 */
export async function loadFromVault(params: LoadFromVaultParams): Promise<VaultCredentials> {
  const authServiceUrl = resolveAuthServiceUrl(params.authServiceUrl);
  const token = await authenticateBootstrapIdentity(authServiceUrl, params.identity);

  const result: VaultCredentials = { values: {}, dids: {}, degraded: [], acks: {} };
  for (const keySpec of params.keys) {
    await loadOneKey(authServiceUrl, token, params.grant, params.purpose, keySpec, result);
  }
  return result;
}
