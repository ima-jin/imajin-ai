/**
 * `ATTESTATION_INTERNAL_API_KEY` fetch-at-boot (#2245 — second target of
 * the #2241 epic, cross-service consumer of a shared internal secret).
 *
 * This is the key `attestation-forwarder.ts` sends as a Bearer token to the
 * kernel's `POST /api/attestations/internal` (checked by
 * `apps/kernel/src/lib/auth/require-internal-api-key.ts`). Before #2245 it
 * was hand-copied into both `apps/kernel/.env.local` and
 * `apps/corpus/.env.local` — rotating it meant editing both hosts. As a
 * vault grant, rotation is revoke + re-grant; both sides pick up the new
 * value on next boot with no file edits.
 *
 * ## Reuses corpus's EXISTING bootstrap identity — no new env var
 * `CORPUS_VAULT_BOOTSTRAP_DID` / `_PRIVATE_KEY` (see `corpus-identity.ts`)
 * already exist purely to authenticate corpus's one-time signing-key fetch
 * (#2243). The kernel grants `ATTESTATION_INTERNAL_API_KEY` to that SAME
 * DID (`scripts/grant-attestation-internal-api-key.ts`, the operator-run
 * "human countersign" step for a shared secret — see
 * `apps/kernel/src/lib/vault/shared-internal-secret.ts`'s docblock), so
 * this module needs no additional bootstrap identity of its own.
 *
 * ## Dynamic grant discovery (no grant-id env var either)
 * Unlike the corpus signing key (`CORPUS_VAULT_GRANT_ID`, a fixed id set
 * once), this secret's grant id is not known ahead of time and CHANGES on
 * rotation. `loadFromVault`'s `resolveGrantByPurpose` (#2245) looks up the
 * CURRENT active grant for this purpose at every boot instead of pinning a
 * literal id — see `packages/auth/src/vault-client.ts`'s "Dynamic grant
 * discovery by purpose" docblock section for why.
 *
 * ## Precedence + soft-fail, same shape as `corpus-identity.ts`
 *  1. `ATTESTATION_INTERNAL_API_KEY` env var set -> DEPRECATED override,
 *     honored verbatim with a loud warning every boot it remains set.
 *  2. No override, but the bootstrap identity is configured -> fetch from
 *     the vault.
 *  3. Neither configured -> `null`; forwarding is skipped (soft-fail,
 *     `attestation-forwarder.ts` already tolerates a missing key exactly
 *     like a missing `AUTH_SERVICE_URL`).
 *
 * ## Ack (#2257, vault path only)
 * Deferred to first actual use — `markAttestationKeyUsedForForwarding()` is
 * called by `attestation-forwarder.ts` right after its first successful
 * forward, mirroring `corpus-identity.ts`'s `markCorpusIdentityUsedForSigning`.
 */
import { createLogger } from '@imajin/logger';
import { loadFromVault, type GrantAckHandle } from '@imajin/auth';

const log = createLogger('corpus');

const VAULT_SOURCED_KEY = 'ATTESTATION_INTERNAL_API_KEY';

// Must match `ATTESTATION_INTERNAL_API_KEY_PURPOSE` in
// apps/kernel/src/lib/auth/require-internal-api-key.ts and
// scripts/grant-attestation-internal-api-key.ts — packages/auth (and by
// extension apps/corpus) must not import apps/kernel internals, so this is
// duplicated rather than imported, same rule `corpus-identity.ts`'s
// `MINTED_KEY_FIELD_PREFIX` precedent already follows.
const ATTESTATION_INTERNAL_API_KEY_PURPOSE = 'kernel.attestation-internal-api-key';

let warnedDeprecatedEnvVar = false;
let vaultSourcedKey: string | null = null;
let vaultSourcedKeyAck: GrantAckHandle | null = null;

/** Test-only: clears in-memory state so each test starts from a clean slate. */
export function _resetAttestationKeyStateForTests(): void {
  warnedDeprecatedEnvVar = false;
  vaultSourcedKey = null;
  vaultSourcedKeyAck = null;
}

function warnDeprecatedEnvVarOnce(): void {
  if (warnedDeprecatedEnvVar) return;
  warnedDeprecatedEnvVar = true;
  log.warn(
    {},
    'DEPRECATED: ATTESTATION_INTERNAL_API_KEY is set. Corpus now fetches this shared key from the vault at boot ' +
      'instead (#2245) — see apps/corpus/.env.example. This override is honored as-is for now, but every boot ' +
      'will keep logging this warning until you unset it.',
  );
}

/**
 * Called by the FIRST successful forward that used the vault-sourced key —
 * `attestation-forwarder.ts`'s `forwardIngestionAttestation`. Sends the
 * deferred `used` ack (#2257: fetching is not itself an ack; using it is).
 * A no-op when corpus has no vault-sourced key (deprecated env override, or
 * neither configured) — idempotent and safe to call on every forward.
 */
export function markAttestationKeyUsedForForwarding(): void {
  vaultSourcedKeyAck?.used('first-forward');
}

/**
 * Runs once at process startup (see `index.ts`, alongside
 * `bootstrapCorpusIdentity()`). No-ops immediately under the deprecated env
 * override. Under the vault path, fetches and caches the key; any failure
 * (network, no active grant yet, vault refusal) is logged and left as "no
 * key" — forwarding degrades to skipped, never a boot failure.
 */
export async function bootstrapAttestationInternalApiKey(): Promise<void> {
  if (process.env.ATTESTATION_INTERNAL_API_KEY) {
    warnDeprecatedEnvVarOnce();
    return;
  }

  const bootstrapDid = process.env.CORPUS_VAULT_BOOTSTRAP_DID;
  const bootstrapPrivateKey = process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY;
  if (!bootstrapDid || !bootstrapPrivateKey) {
    // Neither path configured — attestation-forwarder.ts already warns
    // lazily (via its existing "AUTH_SERVICE_URL or key not set" message)
    // the first time it actually has something to forward.
    return;
  }

  try {
    const credentials = await loadFromVault({
      resolveGrantByPurpose: ATTESTATION_INTERNAL_API_KEY_PURPOSE,
      purpose: 'corpus.boot.attestation-key',
      keys: [{ key: VAULT_SOURCED_KEY, onMissing: 'degrade' }],
      identity: { did: bootstrapDid, privateKey: bootstrapPrivateKey },
    });

    const key = credentials.values[VAULT_SOURCED_KEY];
    const ack = credentials.acks[VAULT_SOURCED_KEY] ?? null;
    if (!key) {
      log.warn(
        {},
        'attestation-key: vault fetch degraded (no active grant for this purpose yet) — ' +
          'ingestion attestation forwarding will be skipped until the kernel operator runs ' +
          'scripts/grant-attestation-internal-api-key.ts for this corpus deployment',
      );
      return;
    }

    vaultSourcedKey = key;
    vaultSourcedKeyAck = ack;
    log.info({}, 'attestation-key: ATTESTATION_INTERNAL_API_KEY fetched from vault at boot (#2245); ack deferred to first use (#2257)');
  } catch (err) {
    log.warn(
      { err: String(err) },
      'attestation-key: vault fetch failed at boot — ingestion attestation forwarding will be skipped',
    );
  }
}

/**
 * Resolves the current `ATTESTATION_INTERNAL_API_KEY` per the precedence
 * documented on this module. Returns `null` when neither the deprecated
 * env override nor a vault-sourced key is available.
 */
export function getAttestationInternalApiKey(): string | null {
  const envOverride = process.env.ATTESTATION_INTERNAL_API_KEY;
  if (envOverride) {
    warnDeprecatedEnvVarOnce();
    return envOverride;
  }

  return vaultSourcedKey;
}
