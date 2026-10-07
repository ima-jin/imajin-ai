/**
 * scripts/readdress-connector-approvals.ts
 *
 * Operator script (#2723): re-addresses PENDING connector approvals that
 * were stored under the node operator's DID to the proposal's owner, so each
 * owner's own /jin Inbox holds them (e.g. a principal's pending GitHub
 * proposals that landed on the operator after #2293).
 *
 * Idempotent and logged — see `readdressPendingConnectorApprovals`. Decided
 * and expired rows are never touched; a second run is a no-op. No schema
 * change: it only rewrites `operator.approvals.operator_did` ("whose Inbox").
 * Reads and decisions already resolve the owner for legacy rows, so running
 * this is data hygiene, not a prerequisite for the owner to see/decide.
 *
 * Usage (from repo root):
 *   npx tsx scripts/readdress-connector-approvals.ts --dry-run   # report only
 *   npx tsx scripts/readdress-connector-approvals.ts             # apply
 *
 * Required env vars:
 *   DATABASE_URL — postgres connection string
 */
import { getClient } from '@imajin/db';
import { readdressPendingConnectorApprovals } from '../apps/kernel/src/lib/notify/approval-readdress.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(`=== Re-address pending connector approvals to their owners (#2723)${dryRun ? ' [dry run]' : ''} ===`);

  const result = await readdressPendingConnectorApprovals({ dryRun });

  result.readdressed.forEach((row) => console.log(`  ${row.proposalId}: ${row.from} -> ${row.to}`));
  console.log(
    `\nDone. ${result.readdressed.length} ${dryRun ? 'would be ' : ''}re-addressed, ` +
      `${result.skippedExpired} skipped (expired), ${result.scanned} candidate(s) scanned.`,
  );

  await getClient().end();
}

main().catch((err) => {
  console.error('Re-address fatal error:', err);
  process.exit(1);
});
