#!/usr/bin/env tsx
/**
 * scripts/grant-attestation-internal-api-key.ts
 *
 * One-time operator script: grants the kernel's self-provisioned
 * `ATTESTATION_INTERNAL_API_KEY` shared internal secret (#2245, second
 * target of the #2241 epic) to an external consumer DID — e.g. corpus's
 * `CORPUS_VAULT_BOOTSTRAP_DID` — so that consumer can fetch it from the
 * vault at boot via `loadFromVault` instead of a hand-copied env var.
 *
 * This is the deliberate, operator-run "human countersign" step the #2245
 * ruling calls for on a shared, cross-service secret (see
 * `apps/kernel/src/lib/vault/shared-internal-secret.ts`'s docblock for the
 * full reasoning) — unlike self-provisioning existence, granting the SAME
 * secret to a SECOND party never happens automatically. Idempotent: running
 * it again for a grantee that already holds an active grant is a no-op
 * that reports the existing grantId.
 *
 * Run against the SAME database/VAULT_PATH the target kernel process uses
 * — this generates the secret (if it doesn't exist yet) via the exact same
 * in-process path the kernel itself uses (`getInternalSecret`), so it must
 * run with the kernel's own signing identity (AUTH_PRIVATE_KEY) available.
 *
 * Usage (from repo root):
 *   npx tsx scripts/grant-attestation-internal-api-key.ts <granteeDid>
 *
 * Example — granting to corpus's bootstrap identity (the DID printed by
 * whatever provisioned CORPUS_VAULT_BOOTSTRAP_DID for the target corpus
 * deployment):
 *   npx tsx scripts/grant-attestation-internal-api-key.ts did:imajin:corpus-bootstrap-abc123
 *
 * Required env vars (same as the target kernel process):
 *   DATABASE_URL      — postgres connection string
 *   AUTH_PRIVATE_KEY  — node signing + seal key
 *   VAULT_PATH        — optional; defaults to ~/.imajin/vault.json
 *
 * `@imajin/logger`'s createLogger and the vault module both write to
 * stdout/stderr as usual — never the secret's plaintext value, only the
 * resulting grantId (a pointer, not a secret).
 */
import { grantInternalSecretTo } from '../apps/kernel/src/lib/vault/index.js';

// Must match `ATTESTATION_INTERNAL_API_KEY_PURPOSE` in
// apps/kernel/src/lib/auth/require-internal-api-key.ts and the literal
// used by apps/corpus/src/lib/attestation-key.ts.
const ATTESTATION_INTERNAL_API_KEY_PURPOSE = 'kernel.attestation-internal-api-key';

// The acting principal recorded on the grant's audit log line — this
// script has no session/identity of its own, so it names itself rather
// than impersonating a DID it doesn't hold the key for.
const GRANTED_BY = 'operator:grant-attestation-internal-api-key-script';

async function main(): Promise<void> {
  const [granteeDid] = process.argv.slice(2);
  if (!granteeDid?.startsWith('did:imajin:')) {
    console.error('Usage: npx tsx scripts/grant-attestation-internal-api-key.ts <granteeDid>');
    console.error('  <granteeDid> must be an already-registered did:imajin:* identity');
    console.error("  (e.g. the corpus service's CORPUS_VAULT_BOOTSTRAP_DID).");
    process.exit(1);
  }

  console.log(`Granting ATTESTATION_INTERNAL_API_KEY (purpose '${ATTESTATION_INTERNAL_API_KEY_PURPOSE}') to ${granteeDid}...`);

  const outcome = await grantInternalSecretTo(ATTESTATION_INTERNAL_API_KEY_PURPOSE, granteeDid, GRANTED_BY);

  switch (outcome.status) {
    case 'ok':
      console.log(`Done. Active grant id: ${outcome.grantId}`);
      console.log(
        'This grantId is a POINTER, not a secret — the grantee discovers it dynamically at boot via ' +
          "loadFromVault's purpose-based lookup (resolveGrantByPurpose), so it never needs to be copied " +
          'into an env var. See apps/corpus/src/lib/attestation-key.ts.',
      );
      return;
    case 'tier1_unsupported':
      console.error('Failed: this vault is running in Tier 1 (external owner agent) mode, which this grant path does not support yet.');
      process.exit(1);
      return;
    case 'no_reusable_grant':
      console.error('Failed: no reusable grant material found for this secret — this should not happen right after self-provisioning.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
