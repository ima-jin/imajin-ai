/**
 * scripts/cleanup-mechanical-pending-attestations.ts (#1825)
 *
 * One-time operator script: resolves the ~1,052 stale `session.created`
 * attestations (and any other type in `MECHANICAL_ATTESTATION_TYPES`) that
 * accumulated with `attestation_status = 'pending'` before #1822 shipped the
 * source fix + countersign-pending view filter.
 *
 * For each mechanical type, this clears `attestation_status` to `NULL` on
 * every row still sitting at `'pending'` — the same terminal state #1822
 * now assigns those types at creation time (see
 * `apps/kernel/src/lib/auth/cleanup-mechanical-pending-attestations.ts` for
 * why `NULL` and not `'bilateral'` / `'declined'` / `'expired'`).
 *
 * Idempotent — safe to re-run. Only rows still `'pending'` are touched, so a
 * second run always reports 0 updated.
 *
 * IMPORTANT: this script does NOT run itself against prod. It defaults to a
 * dry run (count only, no writes) and requires an explicit `--apply` flag to
 * write anything. Running it — in either mode — against a real database is
 * the human operator's call, gated by `DATABASE_URL`.
 *
 * Usage (from repo root):
 *   npx tsx scripts/cleanup-mechanical-pending-attestations.ts            # dry run — counts only, no writes
 *   npx tsx scripts/cleanup-mechanical-pending-attestations.ts --apply    # writes the updates
 *
 * Required env vars:
 *   DATABASE_URL — postgres connection string (same as kernel)
 */
import {
  countMechanicalPendingAttestations,
  cleanupMechanicalPendingAttestations,
} from '../apps/kernel/src/lib/auth/cleanup-mechanical-pending-attestations.js';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`=== Mechanical pending-attestation cleanup (#1825) — ${apply ? 'APPLY' : 'DRY RUN'} ===`);

  if (!apply) {
    const counts = await countMechanicalPendingAttestations();
    let total = 0;
    for (const { type, matched } of counts) {
      console.log(`  [dry-run] ${type}: ${matched} pending row(s) would be resolved`);
      total += matched;
    }
    console.log(`\nDry run complete. ${total} row(s) would be updated.`);
    console.log('Re-run with --apply to write the updates.');
    return;
  }

  const results = await cleanupMechanicalPendingAttestations();
  let total = 0;
  for (const { type, matched } of results) {
    console.log(`  ${type}: ${matched} row(s) resolved (attestation_status -> NULL)`);
    total += matched;
  }
  console.log(`\nDone. ${total} row(s) updated.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Cleanup fatal error:', err);
    process.exit(1);
  });
