import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, attestations, operatorApprovals, type OperatorApprovalRow } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { approvalExpiryDays, approvalExpiryReason } from './approval-attention';
import { resolveApprovalAddressee } from './approval-addressing';

export type ApprovalSourceState = 'gone' | 'superseded';

/** Compare-and-set plus attestation are one transaction: no unsigned terminal state. */
export async function expireApproval(row: OperatorApprovalRow, reason: string): Promise<boolean> {
  if (!['pending', 'approved'].includes(row.status) || row.appliedAt) return false;
  const event = await prepareMechanicalAttestation({
    subjectDid: resolveApprovalAddressee(row, row.operatorDid),
    type: 'operator.approval.expired',
    contextId: row.proposalId,
    contextType: 'operator.approval',
    payload: { proposalId: row.proposalId, previousStatus: row.status, reason },
  });
  return db.transaction(async tx => {
    const won = await tx.update(operatorApprovals).set({
      status: 'expired',
      updatedAt: event.issuedAt,
      // Merge against the live JSONB: preserve archive preferences and outcomes.
      outcome: sql`coalesce(${operatorApprovals.outcome}, '{}'::jsonb)
        || jsonb_build_object('approvalExpiry', ${JSON.stringify({ attestationId: event.id, reason, previousStatus: row.status })}::jsonb)`,
    }).where(and(
      eq(operatorApprovals.proposalId, row.proposalId),
      eq(operatorApprovals.status, row.status),
      sql`${operatorApprovals.appliedAt} is null`,
    )).returning({ proposalId: operatorApprovals.proposalId });
    if (!won.length) return false;
    await tx.insert(attestations).values(event);
    return true;
  });
}

/** Legacy rows are swept by the same policy on the first scheduler tick. */
export async function expireApprovals(now = Date.now()): Promise<number> {
  const days = approvalExpiryDays(process.env.OPERATOR_APPROVAL_EXPIRY_DAYS);
  const rows = await db.select().from(operatorApprovals).where(inArray(operatorApprovals.status, ['pending', 'approved']));
  let expired = 0;
  for (const row of rows) {
    const reason = approvalExpiryReason(row, now, days);
    if (reason && await expireApproval(row, reason)) expired++;
  }
  return expired;
}

/** The authenticated source reports an absent/superseded proposal; absence is never inferred from a network failure. */
export async function reportApprovalSourceState(proposalId: string, state: ApprovalSourceState): Promise<boolean> {
  const [row] = await db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, proposalId)).limit(1);
  if (!row) return false;
  if (row.status === 'expired') return true;
  return expireApproval(row, `source reports ${state}`);
}
