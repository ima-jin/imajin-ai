/**
 * Directory curation on the existing operator-approval rail. A verified,
 * countersigned approval changes only registry metadata, never membership,
 * authorization, service scopes, or provisioning.
 */
import { and, eq, sql } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, registryApps, operatorApprovals } from '@/src/db';
import type { OperatorApprovalCard } from '../notify/operator-approvals-service';
import { resolveVaultAuthorization } from '../vault/authorization';
import { APPS_FEATURED_KIND, parseAppFeaturedDetail, type AppFeaturedDetail } from './featured-kind';

const log = createLogger('kernel:apps:featured');

export async function findPendingFeaturedProposal(detail: AppFeaturedDetail) {
  const rows = await db.select().from(operatorApprovals).where(and(
    eq(operatorApprovals.source, 'apps'),
    eq(operatorApprovals.kind, APPS_FEATURED_KIND),
    eq(operatorApprovals.status, 'pending'),
    sql`${operatorApprovals.detail}->>'appDid' = ${detail.appDid}`,
  ));
  return rows.find((row) => parseAppFeaturedDetail(row.detail)?.featured === detail.featured);
}

type FeaturedExecutionResult =
  | { ok: true; data: AppFeaturedDetail }
  | { ok: false; error: string };

/** Called only with the service-verified decision card, like apps:service-scopes. */
export async function executeAppsFeaturedApproval(card: OperatorApprovalCard): Promise<FeaturedExecutionResult> {
  if (card.source !== 'apps' || card.kind !== APPS_FEATURED_KIND) {
    return { ok: false, error: 'Unrecognized featured proposal' };
  }
  const authorizedBy = resolveVaultAuthorization(card);
  if (!authorizedBy || card.status !== 'approved' || card.decision?.decision !== 'approve'
    || authorizedBy.operatorDid !== card.operatorDid) {
    return { ok: false, error: `${APPS_FEATURED_KIND} requires a countersigned operator approve decision` };
  }
  const detail = parseAppFeaturedDetail(card.detail);
  if (!detail) return { ok: false, error: 'Featured proposal is missing appDid/featured' };

  try {
    // Recheck status in the write predicate: revocation between proposal and
    // approval must not feature an inactive app. Unfeaturing is always allowed.
    const changed = await db.update(registryApps).set({ featured: detail.featured }).where(and(
      eq(registryApps.appDid, detail.appDid),
      ...(detail.featured ? [eq(registryApps.status, 'active')] : []),
    )).returning({ appDid: registryApps.appDid });
    if (!changed.length) return { ok: false, error: 'App not found or not active' };
    return { ok: true, data: detail };
  } catch (err) {
    log.error({ err: String(err), proposalId: card.proposalId }, 'Featured execution failed');
    return { ok: false, error: 'Featured execution failed' };
  }
}
