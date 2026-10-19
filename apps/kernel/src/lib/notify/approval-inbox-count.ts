import { and, eq, or, sql } from 'drizzle-orm';
import { db, operatorApprovals } from '@/src/db';
import { CONNECTOR_KIND_PATTERN } from './approval-addressing';

/**
 * Count the durable Inbox projection, not envelopes, notifications or hydrated
 * cards. Normal publication maintains it; full Inbox reads recover any failed
 * or pre-upgrade publications. Polling is read-only and runs one aggregate.
 */
export async function countInboxApprovals(
  inboxDid: string,
  options: { source?: string; sharedReachPrincipal?: string | null } = {},
): Promise<{ pending: number; total: number }> {
  // SQL equivalent of resolveApprovalAddressee: JSON numbers/objects must not
  // become connector-owner DIDs through ->>'s text coercion.
  const addressee = sql`case when
    ${operatorApprovals.kind} ~ ${CONNECTOR_KIND_PATTERN.source}
    and jsonb_typeof(${operatorApprovals.detail}->'ownerDid') = 'string'
    and ${operatorApprovals.detail}->>'ownerDid' like 'did:%'
    then ${operatorApprovals.detail}->>'ownerDid'
    else ${operatorApprovals.operatorDid} end`;
  const reachCard = or(
    and(eq(operatorApprovals.source, 'reach'), eq(operatorApprovals.kind, 'reach:message')),
    and(eq(operatorApprovals.source, 'knock'), eq(operatorApprovals.kind, 'knock:request')),
  );
  const addressed = eq(addressee, inboxDid);
  const shared = options.sharedReachPrincipal && options.sharedReachPrincipal !== inboxDid
    ? and(eq(addressee, options.sharedReachPrincipal), reachCard) : undefined;
  const [counts] = await db.select({
    pending: sql<number>`count(*) filter (where ${operatorApprovals.status} = 'pending')`.mapWith(Number),
    total: sql<number>`count(*)`.mapWith(Number),
  }).from(operatorApprovals).where(and(
    shared ? or(addressed, shared) : addressed,
    options.source ? eq(operatorApprovals.source, options.source) : undefined,
  ));
  return counts;
}
