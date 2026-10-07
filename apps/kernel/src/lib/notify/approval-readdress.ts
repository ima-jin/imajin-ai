/**
 * Backlog re-address for misrouted connector approvals (#2723).
 *
 * Before #2723 every connector proposal (github …) was stored with
 * `operator_did = <node operator>` no matter whose agent raised it. New rows
 * are now addressed to their owner at creation (`recordApprovalRequested`);
 * this moves the rows that already exist.
 *
 * Scope, exactly:
 *   - ONLY `status = 'pending'` rows. Decided (approved/denied/withdrawn/
 *     applied) and `expired` rows are history and are never touched, and a
 *     pending row whose own `detail.expiresAt` has already passed counts as
 *     expired and is skipped too.
 *   - ONLY connector proposals (`connectorOwnerDid`) whose owner differs from
 *     the stored `operator_did`. The operator's own proposals and every
 *     node-level kind are already where they belong and are not candidates.
 *
 * Idempotent and race-safe: each move is a single guarded UPDATE
 * (`status = 'pending' AND operator_did = <the value we read>`), so a second
 * run finds nothing, and a row decided between the read and the write is left
 * alone. Every move is logged with from/to. `dryRun` reports without writing.
 *
 * No schema change: only the existing `operator_did` column ("whose Inbox",
 * see `approval-addressing.ts`) is rewritten. Reads (`listApprovalsForOperator`)
 * and decisions already resolve the owner for a legacy row, so a row is
 * visible to — and decidable by — its owner and invisible to the operator even
 * before this runs; running it makes the stored data agree.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, operatorApprovals, type OperatorApprovalRow } from '@/src/db';
import { forEachSequential } from '../async/sequential';
import { connectorOwnerDid } from './approval-addressing';

const log = createLogger('kernel:operator-approvals:readdress');

export interface ReaddressedApproval {
  proposalId: string;
  from: string;
  to: string;
}

export interface ReaddressResult {
  /** Pending rows that looked misrouted (owner DID differs from the stored addressee). */
  scanned: number;
  /** Rows actually moved (or, under `dryRun`, that would be moved). */
  readdressed: ReaddressedApproval[];
  /** Candidates skipped because their own `detail.expiresAt` had passed. */
  skippedExpired: number;
}

export interface ReaddressOptions {
  dryRun?: boolean;
  now?: Date;
}

/** True once a pending row's own `detail.expiresAt` has passed; a missing/malformed value never expires. */
function isPastExpiry(detail: OperatorApprovalRow['detail'], now: Date): boolean {
  const expiresAt = detail?.expiresAt;
  if (typeof expiresAt !== 'string') return false;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isNaN(expiresAtMs) && expiresAtMs <= now.getTime();
}

/** Guarded move of one row; returns true only if THIS call moved it. */
async function moveRow(row: OperatorApprovalRow, ownerDid: string): Promise<boolean> {
  const moved = await db
    .update(operatorApprovals)
    .set({ operatorDid: ownerDid })
    .where(
      and(
        eq(operatorApprovals.proposalId, row.proposalId),
        eq(operatorApprovals.status, 'pending'),
        eq(operatorApprovals.operatorDid, row.operatorDid),
      ),
    )
    .returning({ proposalId: operatorApprovals.proposalId });
  return moved.length > 0;
}

export async function readdressPendingConnectorApprovals(options: ReaddressOptions = {}): Promise<ReaddressResult> {
  const { dryRun = false, now = new Date() } = options;

  const candidates = await db
    .select()
    .from(operatorApprovals)
    .where(
      and(
        eq(operatorApprovals.status, 'pending'),
        sql`${operatorApprovals.detail}->>'ownerDid' IS NOT NULL`,
        ne(operatorApprovals.operatorDid, sql`${operatorApprovals.detail}->>'ownerDid'`),
      ),
    );

  const result: ReaddressResult = { scanned: 0, readdressed: [], skippedExpired: 0 };

  // Sequential on purpose: one guarded write at a time keeps the log ordered and failures attributable.
  await forEachSequential(candidates, async (row) => {
    const ownerDid = connectorOwnerDid(row);
    if (!ownerDid || ownerDid === row.operatorDid) return;
    result.scanned += 1;

    if (isPastExpiry(row.detail, now)) {
      result.skippedExpired += 1;
      return;
    }
    if (!dryRun && !(await moveRow(row, ownerDid))) return;

    result.readdressed.push({ proposalId: row.proposalId, from: row.operatorDid, to: ownerDid });
    log.info(
      { proposalId: row.proposalId, kind: row.kind, from: row.operatorDid, to: ownerDid, dryRun },
      dryRun ? 'would re-address pending connector approval to its owner' : 're-addressed pending connector approval to its owner',
    );
  });

  log.info(
    { scanned: result.scanned, readdressed: result.readdressed.length, skippedExpired: result.skippedExpired, dryRun },
    'connector approval re-address complete',
  );
  return result;
}
