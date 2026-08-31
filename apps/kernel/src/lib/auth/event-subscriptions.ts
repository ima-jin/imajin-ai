/**
 * Grant-bound event-subscription cursor catch-up (#1884).
 *
 * Entitlement is derived fresh from #1882's active grants on every call —
 * never cached, never a stored subscription ACL — so a revoked or expired
 * grant sees nothing further, including events published before it was
 * revoked ("subscription death is grant death", #1881 Day-1 review item 4:
 * "a revoked grant stops event flow at the next delivery check, not
 * eventually").
 *
 * This is the read-side counterpart to packages/bus/src/subscriptions.ts,
 * which persists every event whose type any grant scope could entitle. The
 * two never share entitlement state — each independently recomputes it from
 * `auth.delegation_grants` / `auth.delegation_grant_capabilities` at the
 * moment of delivery (live push) or read (catch-up).
 */
import { and, asc, eq, gt, gte, inArray } from 'drizzle-orm';
import {
  db,
  delegationGrants,
  delegationGrantCapabilities,
  eventSubscriptionLog,
} from '@/src/db';
import {
  audienceAllows,
  eventTypesForGrantScopes,
  EVENT_SUBSCRIPTION_RETENTION,
  EVENT_SUBSCRIPTION_CATCHUP_PAGE_SIZE,
  type DelegationAudience,
  type GrantScope,
} from '@imajin/auth';

export interface CaughtUpEvent {
  id: string;
  cursor: string;
  eventType: string;
  issuer: string;
  subject: string;
  scope: string;
  payload: Record<string, unknown> | null;
  correlationId: string | null;
  occurredAt: string;
  /** Dual-stamp-compatible provenance: which of the caller's grants entitled this event. */
  grantId: string;
}

export interface CatchUpResult {
  events: CaughtUpEvent[];
  nextCursor: string;
  entitledEventTypes: string[];
}

interface ActiveGrant {
  grantId: string;
  audience: DelegationAudience;
  capabilities: GrantScope[];
}

/** Active, unexpired grants for `agentDid`, with their active capabilities attached. */
async function loadActiveGrants(agentDid: string): Promise<ActiveGrant[]> {
  const now = new Date();
  const grantRows = await db
    .select({ id: delegationGrants.id, audience: delegationGrants.audience })
    .from(delegationGrants)
    .where(
      and(
        eq(delegationGrants.agentDid, agentDid),
        eq(delegationGrants.status, 'active'),
        gt(delegationGrants.expiresAt, now),
      ),
    );
  if (grantRows.length === 0) return [];

  const capabilityRows = await db
    .select({ grantId: delegationGrantCapabilities.grantId, capability: delegationGrantCapabilities.capability })
    .from(delegationGrantCapabilities)
    .where(
      and(
        inArray(delegationGrantCapabilities.grantId, grantRows.map((g: { id: string }) => g.id)),
        eq(delegationGrantCapabilities.status, 'active'),
      ),
    );

  const capsByGrant = new Map<string, GrantScope[]>();
  for (const row of capabilityRows) {
    const list = capsByGrant.get(row.grantId) ?? [];
    list.push(row.capability as GrantScope);
    capsByGrant.set(row.grantId, list);
  }

  return grantRows
    .map((g: { id: string; audience: unknown }) => ({
      grantId: g.id,
      audience: g.audience as DelegationAudience,
      capabilities: capsByGrant.get(g.id) ?? [],
    }))
    .filter((g: ActiveGrant) => g.capabilities.length > 0);
}

/**
 * Resolve missed events for `agentDid` since `cursor`, filtered to what its
 * *currently* active grants entitle. `nextCursor` always advances to the
 * last row considered (even when some rows were filtered out by audience),
 * so a caller polling in a loop never re-fetches the same window.
 */
export async function catchUpSubscriptionEvents(params: {
  agentDid: string;
  cursor: bigint;
  limit?: number;
}): Promise<CatchUpResult> {
  const grants = await loadActiveGrants(params.agentDid);
  const entitledEventTypes = [...new Set(grants.flatMap((g) => eventTypesForGrantScopes(g.capabilities)))];

  if (entitledEventTypes.length === 0) {
    return { events: [], nextCursor: params.cursor.toString(), entitledEventTypes: [] };
  }

  const limit = Math.min(
    Math.max(params.limit ?? EVENT_SUBSCRIPTION_CATCHUP_PAGE_SIZE, 1),
    EVENT_SUBSCRIPTION_CATCHUP_PAGE_SIZE,
  );
  const retentionCutoff = new Date(Date.now() - EVENT_SUBSCRIPTION_RETENTION);

  const rows = await db
    .select()
    .from(eventSubscriptionLog)
    .where(
      and(
        gt(eventSubscriptionLog.seq, params.cursor),
        inArray(eventSubscriptionLog.eventType, entitledEventTypes),
        gte(eventSubscriptionLog.occurredAt, retentionCutoff),
      ),
    )
    .orderBy(asc(eventSubscriptionLog.seq))
    .limit(limit);

  if (rows.length === 0) {
    return { events: [], nextCursor: params.cursor.toString(), entitledEventTypes };
  }

  const events: CaughtUpEvent[] = [];
  for (const row of rows) {
    // A type can be entitled by one grant but the row's subject may not
    // match that grant's audience — re-check per row, per grant, exactly
    // like the live-push path in packages/bus/src/subscriptions.ts.
    const matchingGrant = grants.find(
      (g) => eventTypesForGrantScopes(g.capabilities).includes(row.eventType) && audienceAllows(g.audience, row.subjectDid),
    );
    if (!matchingGrant) continue;
    events.push({
      id: row.id,
      cursor: row.seq.toString(),
      eventType: row.eventType,
      issuer: row.issuerDid,
      subject: row.subjectDid,
      scope: row.scope,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt.toISOString(),
      grantId: matchingGrant.grantId,
    });
  }

  // Advance past every row considered in this page, not just the ones that
  // survived the audience filter, so a caller's next request never re-scans
  // rows it has already seen (and rejected) once.
  const nextCursor = rows[rows.length - 1].seq.toString();
  return { events, nextCursor, entitledEventTypes };
}
