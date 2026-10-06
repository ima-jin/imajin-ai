import { createLogger } from '@imajin/logger';
import { loadFromVault, type GrantAckHandle } from './vault-client';

const log = createLogger('auth');

let deprecatedKeyWarned = false;

// Must match `ATTESTATION_INTERNAL_API_KEY_PURPOSE` in
// apps/kernel/src/lib/auth/require-internal-api-key.ts — duplicated rather
// than imported because packages/auth must not depend on apps/kernel.
const ATTESTATION_INTERNAL_API_KEY_PURPOSE = 'kernel.attestation-internal-api-key';
const VAULT_SOURCED_KEY = 'ATTESTATION_INTERNAL_API_KEY';

// Held on globalThis (not module scope): Next.js bundles `instrumentation.ts`
// (where the boot fetch runs) separately from the route handlers, so a
// module-level variable would not be shared between them.
const VAULT_KEY_STATE = Symbol.for('@imajin/auth/vault-attestation-internal-api-key');
interface VaultKeyState {
  key: string;
  ack: GrantAckHandle | null;
}
const globalState = globalThis as { [VAULT_KEY_STATE]?: VaultKeyState };

/**
 * Fetches the shared `ATTESTATION_INTERNAL_API_KEY` from the vault at boot
 * (#2353 — every userspace service except corpus, which has its own copy in
 * `apps/corpus/src/lib/attestation-key.ts`) using the service's
 * `<SERVICE>_VAULT_BOOTSTRAP_DID` / `_PRIVATE_KEY` identity and a
 * purpose-based grant lookup (#2245). Never throws: a missing identity or a
 * failed fetch is logged as an error and leaves the key unset, so kernel calls
 * fail closed (skipped / 401) rather than crashing boot.
 */
export async function bootstrapInternalApiKey(service: string): Promise<void> {
  const prefix = service.toUpperCase();
  const did = process.env[`${prefix}_VAULT_BOOTSTRAP_DID`];
  const privateKey = process.env[`${prefix}_VAULT_BOOTSTRAP_PRIVATE_KEY`];
  if (!did || !privateKey) {
    log.error({}, `${prefix}_VAULT_BOOTSTRAP_DID/_PRIVATE_KEY not set — cannot fetch ATTESTATION_INTERNAL_API_KEY from the vault`);
    return;
  }

  try {
    const credentials = await loadFromVault({
      resolveGrantByPurpose: ATTESTATION_INTERNAL_API_KEY_PURPOSE,
      purpose: `${service}.boot.attestation-key`,
      keys: [{ key: VAULT_SOURCED_KEY, onMissing: 'degrade' }],
      identity: { did, privateKey },
    });
    const key = credentials.values[VAULT_SOURCED_KEY];
    if (!key) {
      log.error({}, 'No active vault grant for ATTESTATION_INTERNAL_API_KEY — run scripts/grant-attestation-internal-api-key.ts for this service DID');
      return;
    }
    globalState[VAULT_KEY_STATE] = { key, ack: credentials.acks[VAULT_SOURCED_KEY] ?? null };
  } catch (err) {
    log.error({ err: String(err) }, 'Vault fetch of ATTESTATION_INTERNAL_API_KEY failed at boot');
  }
}

/**
 * Hands packages/auth the already-resolved `ATTESTATION_INTERNAL_API_KEY` for a
 * process that does not fetch it through `bootstrapInternalApiKey` — i.e. the
 * kernel, which hosts the vault and resolves the value itself
 * (`getInternalSecret`). The value must come from the vault; packages/auth
 * never reads it from `process.env` (#2353 step 4).
 */
export function provideInternalApiKey(key: string): void {
  if (!key) throw new Error('provideInternalApiKey: refusing to register an empty key');
  globalState[VAULT_KEY_STATE] = { key, ack: null };
}

/**
 * The vault-sourced `ATTESTATION_INTERNAL_API_KEY`, or `undefined` if the
 * boot fetch has not run / failed. The first read sends the deferred `used`
 * ack for the grant (#2257: fetching is not itself an ack; using it is).
 */
export function getVaultInternalApiKey(): string | undefined {
  const state = globalState[VAULT_KEY_STATE];
  if (!state) return undefined;
  state.ack?.used('first-use');
  state.ack = null;
  return state.key;
}

/**
 * Resolves the shared secret used to authenticate every packages/auth
 * service-to-service call to the kernel's `ATTESTATION_INTERNAL_API_KEY`-gated
 * routes (`/api/attestations/internal`, `/api/attestations/chain-emit`,
 * `/api/eligibility/evaluate`, `/api/identity/:did/contact`) — all of them
 * check `ATTESTATION_INTERNAL_API_KEY` exclusively. That value is the
 * vault-sourced one (`bootstrapInternalApiKey`), never `process.env` (#2353).
 * `AUTH_INTERNAL_API_KEY` is accepted as a deprecated fallback for one release
 * (#2037: the two names had drifted apart, so this file sent a key neither
 * route ever checked and every mechanical attestation forward was silently
 * rejected). Warns once per process — not once per call — so a misconfigured
 * deployment shows up without spamming the logs.
 */
export function resolveInternalApiKey(): string | undefined {
  const vaultKey = getVaultInternalApiKey();
  if (vaultKey) return vaultKey;

  const legacy = process.env.AUTH_INTERNAL_API_KEY;
  if (legacy && !deprecatedKeyWarned) {
    deprecatedKeyWarned = true;
    console.warn(
      '[auth] AUTH_INTERNAL_API_KEY is deprecated for attestation forwarding (#2037) — the vault-sourced ATTESTATION_INTERNAL_API_KEY (bootstrapInternalApiKey) was not loaded. This fallback will be removed in a future release.',
    );
  }
  return legacy;
}

export interface InternalPostOutcome<T> {
  /** Mirrors `Response.ok` — true for a 2xx status. */
  ok: boolean;
  status: number;
  /** Parsed JSON body, or `null` if parsing failed or the body was empty. */
  data: T | null;
}

/**
 * Shared service-to-service POST transport (#2058) used by every
 * packages/auth client of the kernel's internal-key-gated routes —
 * `evaluateEligibility`, `backfillContactEmail`, `emitAttestation`.
 * Extracted to fix a SonarCloud duplicated-lines finding: `evaluateEligibility`
 * (#1999) and `emitAttestation` (#1820/#2037) each hand-rolled this same
 * AUTH_SERVICE_URL + Bearer-token POST boilerplate, and `backfillContactEmail`
 * (#2058) would have made it a third near-identical copy.
 *
 * Resolves `AUTH_SERVICE_URL` and the internal API key, then performs the
 * POST with a `Content-Type: application/json` body and a
 * `Authorization: Bearer <key>` header.
 *
 * Returns `null` when the service isn't configured (no `AUTH_SERVICE_URL`
 * or no internal API key) — callers log their own "skipped" message in
 * that case, same as before this extraction. Otherwise returns
 * `{ ok, status, data }`: `ok` mirrors `Response.ok` and `data` is the
 * parsed JSON body (or `null` if parsing failed or there was no body), so
 * each caller can log its own rejection message and apply any
 * caller-specific side effect (e.g. `emitAttestation`'s failure counter).
 *
 * Deliberately does not catch fetch/network errors itself — those
 * propagate so each caller can log its own error message with its own
 * context, exactly as each did before this extraction.
 */
export async function postInternal<T>(path: string, body: unknown): Promise<InternalPostOutcome<T> | null> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  const internalApiKey = resolveInternalApiKey();
  if (!authServiceUrl || !internalApiKey) return null;

  const res = await fetch(`${authServiceUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${internalApiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json().catch(() => null)) as T | null;
  return { ok: res.ok, status: res.status, data };
}
