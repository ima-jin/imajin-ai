/**
 * scripts/migrate-github-proposals-to-operator-approvals.ts
 *
 * One-time operator script (#2293): backfills `operator.approvals` cards
 * for every IN-FLIGHT `github.action_proposals` row that predates this
 * fold — a pending proposal, or a live (not yet lapsed) windowed approval.
 * Without this, a proposal raised before the deploy that shipped #2293
 * stays invisible on /jin forever (the connector only raises a NEW card
 * going forward, in `requireWriteGate`'s pending-insert branch).
 *
 * Idempotent: `ON CONFLICT (proposal_id) DO NOTHING`, so running it twice
 * (or after some cards already exist from post-deploy traffic) is safe.
 * Terminal rows (done/denied/expired) are intentionally NOT backfilled —
 * they are history, not something awaiting the operator's attention, and
 * the acceptance bar is "no silently lost PENDING approvals", not a full
 * historical import.
 *
 * Uses the REAL `computeApprovalContentHash`/`getOperatorDid` kernel
 * functions (not a from-scratch SQL reimplementation of the hash) so the
 * backfilled `content_hash` is byte-identical to what a freshly-raised
 * proposal would compute.
 *
 * Run ONCE per environment, ideally immediately before or immediately
 * after the deploy that ships #2293 — see the PR description's cutover
 * notes for the exact timing recommendation.
 *
 * Usage (from repo root):
 *   npx tsx scripts/migrate-github-proposals-to-operator-approvals.ts
 *
 * Required env vars:
 *   DATABASE_URL — postgres connection string
 *   (relay.relay_config.node_operator_did must already be configured —
 *   see getOperatorDid()'s docs; a node with no operator configured has
 *   no /jin operator-approvals surface at all, same pre-existing
 *   constraint every other kind on this rail already has.)
 */
import { getClient } from '@imajin/db';
import { computeApprovalContentHash, getOperatorDid } from '../apps/kernel/src/lib/notify/operator-approvals.js';
import { GITHUB_SOURCE, GITHUB_APPEND_KIND, GITHUB_MUTATE_KIND } from '../apps/kernel/src/lib/github/approvals-execution.js';

const sql = getClient();

interface LegacyProposalRow {
  id: string;
  owner_did: string;
  agent_did: string | null;
  scope: string;
  tool: string;
  risk_tier: 'append' | 'mutate';
  target: string;
  args_summary: string;
  status: 'pending' | 'approved' | 'done' | 'denied' | 'expired';
  approved_until: string | null;
  owner_authorization: Record<string, unknown> | null;
  created_at: string;
}

function kindForRiskTier(riskTier: 'append' | 'mutate'): string {
  return riskTier === 'append' ? GITHUB_APPEND_KIND : GITHUB_MUTATE_KIND;
}

async function backfillRow(row: LegacyProposalRow, operatorDid: string): Promise<void> {
  const kind = kindForRiskTier(row.risk_tier);
  const detail = {
    ownerDid: row.owner_did,
    agentDid: row.agent_did,
    scope: row.scope,
    riskTier: row.risk_tier,
    tool: row.tool,
    target: row.target,
    argsSummary: row.args_summary,
  };
  const contentHash = computeApprovalContentHash({
    proposalId: row.id,
    source: GITHUB_SOURCE,
    kind,
    summary: row.args_summary,
    keysTouched: [],
    detail,
  });

  const outcome = row.status === 'approved'
    ? { approvedUntil: row.approved_until, ownerAuthorization: row.owner_authorization }
    : null;

  await sql`
    INSERT INTO operator.approvals (
      proposal_id, operator_did, source, kind, summary, keys_touched,
      detail, content_hash, notification_id, status, outcome, created_at, updated_at
    )
    VALUES (
      ${row.id}, ${operatorDid}, ${GITHUB_SOURCE}, ${kind}, ${row.args_summary}, ${JSON.stringify([])},
      ${JSON.stringify(detail)}, ${contentHash}, NULL, ${row.status}, ${outcome ? JSON.stringify(outcome) : null},
      ${row.created_at}, now()
    )
    ON CONFLICT (proposal_id) DO NOTHING
  `;
}

async function main() {
  console.log('=== GitHub proposals -> operator.approvals cutover (#2293) ===');

  const operatorDid = await getOperatorDid();
  if (!operatorDid) {
    console.error('No node operator configured (relay.relay_config.node_operator_did is unset) — nothing to backfill against. Configure the operator first, then re-run.');
    process.exit(1);
  }
  console.log(`Backfilling cards addressed to operator ${operatorDid}`);

  const rows = await sql<LegacyProposalRow[]>`
    SELECT id, owner_did, agent_did, scope, tool, risk_tier, target, args_summary,
           status, approved_until, owner_authorization, created_at
    FROM github.action_proposals
    WHERE status = 'pending'
       OR (status = 'approved' AND (approved_until IS NULL OR approved_until > now()))
  `;

  console.log(`Found ${rows.length} in-flight legacy proposal(s) to backfill.`);

  let successCount = 0;
  let failCount = 0;

  for (const row of rows) {
    try {
      await backfillRow(row, operatorDid);
      successCount++;
    } catch (err) {
      console.error(`  FAILED for proposal ${row.id}:`, err);
      failCount++;
      // Continue — do not abort the whole backfill on a single failure.
    }
  }

  console.log(`\nDone. ${successCount} backfilled (or already present), ${failCount} failed.`);
  if (failCount > 0) {
    console.error('Some rows failed — review errors above before considering the cutover complete.');
    process.exit(1);
  }

  await sql.end();
}

main().catch((err) => {
  console.error('Migration fatal error:', err);
  process.exit(1);
});
