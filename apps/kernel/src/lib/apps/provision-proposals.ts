/**
 * Lookup helper for `POST /api/apps/provision` (#2375): find an already-
 * pending `apps:provision` proposal for a given slug, so a repeat POST
 * reuses the existing operator-approvals card instead of raising a
 * duplicate one. Mirrors the `detail->>'field' = value` query shape
 * `github/connector.ts`'s `retireLapsedApprovals` already uses against
 * the same `operator.approvals` table.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, operatorApprovals, type OperatorApprovalRow } from '@/src/db';
import { APPS_SOURCE, APPS_PROVISION_KIND } from './approvals-execution';

export async function findPendingAppsProvisionProposal(slug: string): Promise<OperatorApprovalRow | undefined> {
  const [row] = await db
    .select()
    .from(operatorApprovals)
    .where(
      and(
        eq(operatorApprovals.source, APPS_SOURCE),
        eq(operatorApprovals.kind, APPS_PROVISION_KIND),
        eq(operatorApprovals.status, 'pending'),
        sql`${operatorApprovals.detail}->>'slug' = ${slug}`,
      ),
    )
    .limit(1);
  return row;
}
