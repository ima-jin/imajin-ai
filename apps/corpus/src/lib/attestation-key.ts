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
 * ## Vault-only + soft-fail, same shape as `corpus-identity.ts`
 * The vault is the ONLY source (#2353 step 4 removed the deprecated
 * `ATTESTATION_INTERNAL_API_KEY` env override — a hand-set env var is
 * ignored). Bootstrap identity configured -> fetch from the vault; otherwise
 * `null`, and forwarding is skipped with a loud error (soft-fail,
 * `attestation-forwarder.ts` already tolerates a missing key exactly like a
 * missing `AUTH_SERVICE_URL`).
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

let vaultSourcedKey: string | null = null;
let vaultSourcedKeyAck: GrantAckHandle | null = null;

/** Test-only: seeds the vault-sourced key a successful boot fetch would have cached. */
export function _setAttestationKeyForTests(key: string): void {
  vaultSourcedKey = key;
  vaultSourcedKeyAck = null;
}

/** Test-only: clears in-memory state so each test starts from a clean slate. */
export function _resetAttestationKeyStateForTests(): void {
  vaultSourcedKey = null;
  vaultSourcedKeyAck = null;
}

/**
 * Called by the FIRST successful forward that used the vault-sourced key —
 * `attestation-forwarder.ts`'s `forwardIngestionAttestation`. Sends the
 * deferred `used` ack (#2257: fetching is not itself an ack; using it is).
 * A no-op when corpus has no vault-sourced key — idempotent and safe to call
 * on every forward.
 */
export function markAttestationKeyUsedForForwarding(): void {
  vaultSourcedKeyAck?.used('first-forward');
}

/**
 * Runs once at process startup (see `index.ts`, alongside
 * `bootstrapCorpusIdentity()`). Fetches and caches the key from the vault; any
 * failure (network, no active grant yet, vault refusal) is logged and left as
 * "no key" — forwarding degrades to skipped, never a boot failure.
 */
export async function bootstrapAttestationInternalApiKey(): Promise<void> {
  const bootstrapDid = process.env.CORPUS_VAULT_BOOTSTRAP_DID;
  const bootstrapPrivateKey = process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY;
  if (!bootstrapDid || !bootstrapPrivateKey) {
    // No hand-set env fallback exists (#2353 step 4): without the bootstrap
    // identity the key can never be loaded, so say so at boot.
    log.error(
      {},
      'attestation-key: CORPUS_VAULT_BOOTSTRAP_DID/_PRIVATE_KEY not set — cannot fetch ATTESTATION_INTERNAL_API_KEY ' +
        'from the vault; ingestion attestation forwarding will be skipped',
    );
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
 * The vault-sourced `ATTESTATION_INTERNAL_API_KEY`, or `null` when the boot
 * fetch has not run / failed. Never reads `process.env` (#2353 step 4).
 */
export function getAttestationInternalApiKey(): string | null {
  return vaultSourcedKey;
}
