/**
 * Corpus service identity (#1751, folded into #2021's "Ingestion
 * attestations" checklist item; fetch-at-boot rework in #2243, child of
 * epic #2241).
 *
 * The corpus service signs its own `IngestionAttestation`s (#1750) with a
 * service DID keypair distinct from the kernel's node identity — corpus
 * must never hold or derive the kernel's private key (see the module
 * comment on `middleware/access-claim.ts`), and symmetrically the kernel
 * never holds the corpus service's private key either.
 *
 * ## Precedence, resolved once at boot by {@link bootstrapCorpusIdentity}
 * (see `index.ts`), then re-checked live by {@link loadCorpusIdentity} on
 * every call (mirrors `kernel-trust.ts`'s always-live-read pattern so a
 * test — or an operator — setting/unsetting the env vars takes effect
 * immediately):
 *
 *  1. `CORPUS_DID` + `CORPUS_DID_PRIVATE_KEY` set -> DEPRECATED override.
 *     Used verbatim as corpus's signing identity, logging a LOUD warning
 *     every boot while they remain set — same shape as #2244's
 *     `CORPUS_KERNEL_PUBLIC_KEY` deprecation (`kernel-trust.ts`). Minted via
 *     `scripts/bootstrap-corpus-identity.ts`. Exists so a prod corpus that
 *     still has these hand-provisioned (prod is HELD at v0.6.1 per #2241)
 *     keeps booting unchanged.
 *  2. No override, but `CORPUS_VAULT_GRANT_ID` +
 *     `CORPUS_VAULT_BOOTSTRAP_DID` + `CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY`
 *     are set -> the #2243 path: `loadFromVault()` fetches the REAL signing
 *     keypair (minted in-vault per #2242) through a one-time delegation
 *     grant, authenticating as the small bootstrap identity named by the
 *     `CORPUS_VAULT_BOOTSTRAP_*` pair. The fetched `{did, privateKey}` is
 *     cached in memory for the life of the process — never written to
 *     disk, env, or logs — and used as corpus's signing identity from then
 *     on. See this module's `.env.example` entry and the #2243 PR
 *     description ("Deploy notes") for how that bootstrap identity and
 *     grant get provisioned.
 *  3. Neither configured -> `null`, exactly like before #2243: ingestion
 *     still succeeds, just without signed provenance, with a one-time
 *     warning (see `warnedMissingIdentity` below).
 *
 * Absence is always a soft-fail, not a startup error: a freshly-deployed
 * corpus service with no identity configured yet must still ingest and
 * serve search successfully, just without signed provenance. Every call
 * site downstream (`engine/index.ts`) treats a `null` identity as "skip
 * attestation for this batch," never as a reason to fail the request or
 * sign with a placeholder key.
 *
 * ## Grant ack (#2257, applies only to the vault path above)
 * `loadFromVault()` no longer acks the fetch itself — it hands back a
 * deferred `GrantAckHandle` instead (see `packages/auth/src/vault-client.ts`'s
 * docblock for the full ruling). This module is corpus's half of that
 * contract:
 *  - A vault fetch that comes back without a usable minted keypair is a
 *    boot/startup failure attributable to that key -> `ack.failed()`,
 *    right here in {@link bootstrapCorpusIdentity}.
 *  - A vault fetch that DOES yield a usable identity stashes its ack
 *    handle in `vaultSourcedIdentityAck`; {@link markCorpusIdentityUsedForSigning}
 *    (called by `engine/index.ts` at the first successful signing) sends
 *    the deferred `used` ack exactly once.
 *  - If corpus never signs anything before it exits, `loadFromVault`'s own
 *    process-exit safety net sends `discarded` — this module does nothing
 *    for that case.
 */
import { createLogger } from '@imajin/logger';
import { loadFromVault, type GrantAckHandle } from '@imajin/auth';

const log = createLogger('corpus');

export interface CorpusIdentity {
  did: string;
  privateKey: string;
}

const VAULT_SOURCED_KEY = 'CORPUS_DID_PRIVATE_KEY';

let warnedMissingIdentity = false;
let warnedDeprecatedEnvVar = false;
let vaultSourcedIdentity: CorpusIdentity | null = null;
/**
 * The deferred #2257 ack handle for `vaultSourcedIdentity`'s grant, if it
 * came from the vault path. `null` under the deprecated env override (no
 * vault fetch ever happens) and when no identity is configured at all —
 * neither path ever holds a grant to ack.
 */
let vaultSourcedIdentityAck: GrantAckHandle | null = null;

/** Test-only: clears in-memory state so each test starts from a clean slate. */
export function _resetCorpusIdentityStateForTests(): void {
  warnedMissingIdentity = false;
  warnedDeprecatedEnvVar = false;
  vaultSourcedIdentity = null;
  vaultSourcedIdentityAck = null;
}

/**
 * Called by the FIRST successful use of the vault-sourced signing key —
 * currently `engine/index.ts`'s `ingest()`, right after it builds+signs a
 * batch's first `IngestionAttestation` (#1750). Sends the deferred `used`
 * ack for #2257's ruling: fetching a secret from the vault is not itself
 * an ack (the kernel's fetch event already records that); USING it is.
 * Idempotent and safe to call on every ingest — the underlying
 * `GrantAckHandle` only ever sends its first ack — and a no-op when corpus
 * has no vault-sourced identity (deprecated env override, or no identity
 * configured at all).
 */
export function markCorpusIdentityUsedForSigning(): void {
  vaultSourcedIdentityAck?.used('first-sign');
}

/** Logs the `CORPUS_DID`/`CORPUS_DID_PRIVATE_KEY` deprecation warning once per process. */
function warnDeprecatedEnvVarOnce(): void {
  if (warnedDeprecatedEnvVar) return;
  warnedDeprecatedEnvVar = true;
  log.warn(
    {},
    'DEPRECATED: CORPUS_DID/CORPUS_DID_PRIVATE_KEY is set. Corpus now fetches its signing key from the vault ' +
      'at boot instead (#2243) — see apps/corpus/.env.example for the CORPUS_VAULT_* replacement. This override ' +
      'is honored as-is for now, but every boot will keep logging this warning until you unset it.',
  );
}

/**
 * Runs once at process startup (see `index.ts`, alongside
 * `bootstrapKernelTrust()`). No-ops immediately under the deprecated env
 * override — {@link loadCorpusIdentity} reads that live on every call, so
 * there is nothing to cache for that path. Under the vault path, fetches
 * and caches the real signing identity; any failure (network, missing
 * grant, vault refusal) is logged and left as "no identity" — matching
 * this module's existing soft-fail-on-missing-identity contract, never a
 * boot failure.
 */
export async function bootstrapCorpusIdentity(): Promise<void> {
  if (process.env.CORPUS_DID && process.env.CORPUS_DID_PRIVATE_KEY) {
    warnDeprecatedEnvVarOnce();
    return;
  }

  const grant = process.env.CORPUS_VAULT_GRANT_ID;
  const bootstrapDid = process.env.CORPUS_VAULT_BOOTSTRAP_DID;
  const bootstrapPrivateKey = process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY;
  if (!grant || !bootstrapDid || !bootstrapPrivateKey) {
    // Neither path configured — same as today, `loadCorpusIdentity()` warns
    // lazily on first use rather than at boot.
    return;
  }

  try {
    const credentials = await loadFromVault({
      grant,
      purpose: 'corpus.boot.signing-key',
      keys: [{ key: VAULT_SOURCED_KEY, onMissing: 'degrade' }],
      identity: { did: bootstrapDid, privateKey: bootstrapPrivateKey },
    });

    const privateKey = credentials.values[VAULT_SOURCED_KEY];
    const did = credentials.dids[VAULT_SOURCED_KEY];
    const ack = credentials.acks[VAULT_SOURCED_KEY] ?? null;
    if (!privateKey || !did) {
      // `ack` is only set when the vault fetch itself succeeded (#2257) — if
      // it's present here, corpus DID consume a grant but got back
      // something that isn't a usable minted keypair (missing `did`), which
      // is exactly the ruling's "boot/startup failure attributable to the
      // key". When `ack` is null, nothing was fetched at all (a plain
      // `onMissing: 'degrade'` refusal) — there is no grant to ack.
      ack?.failed('unusable-minted-key');
      log.warn(
        {},
        'corpus-identity: vault fetch degraded (no signing key returned) — ingestion will proceed without signed attestations',
      );
      return;
    }

    vaultSourcedIdentity = { did, privateKey };
    vaultSourcedIdentityAck = ack;
    log.info({ did }, 'corpus-identity: signing key fetched from vault at boot (#2243); ack deferred to first use (#2257)');
  } catch (err) {
    log.warn(
      { err: String(err) },
      'corpus-identity: vault fetch failed at boot — ingestion will proceed without signed attestations',
    );
  }
}

/**
 * Resolves corpus's current signing identity per the precedence documented
 * on this module. Returns `null` (after logging a one-time warning, not on
 * every ingest) when no identity is configured or fetchable at all.
 */
export function loadCorpusIdentity(): CorpusIdentity | null {
  const did = process.env.CORPUS_DID;
  const privateKey = process.env.CORPUS_DID_PRIVATE_KEY;
  if (did && privateKey) {
    warnDeprecatedEnvVarOnce();
    return { did, privateKey };
  }

  if (vaultSourcedIdentity) {
    return vaultSourcedIdentity;
  }

  if (!warnedMissingIdentity) {
    warnedMissingIdentity = true;
    log.warn(
      {},
      'CORPUS_DID/CORPUS_DID_PRIVATE_KEY not configured (and no vault-sourced signing key was fetched at boot) — ' +
        'ingestion will proceed without signed attestations',
    );
  }
  return null;
}
