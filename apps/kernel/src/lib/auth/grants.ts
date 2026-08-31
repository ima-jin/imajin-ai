/**
 * Scoped delegation grant lifecycle (#1882).
 *
 * A grant lets a `delegatorDid` principal authorize a specific `agentDid`
 * external agent to exercise a closed set of `domain:verb` capabilities
 * against a bounded `audience`, for a bounded lease (`expiresAt`). This is
 * deliberately separate from the coarse `identity_members` role='agent'
 * bootstrap that `X-Acting-For` / `verify-delegation` checks — that surface
 * has no grant/revoke lifecycle, no per-capability granularity, and no
 * expiry (the gap #1881's Day-1 audit found).
 *
 * Invariants enforced here, not just documented:
 *   - User-push only: callers pass `delegatorDid` explicitly; nothing in this
 *     module ever derives it from the agent's own request. The route layer
 *     is responsible for sourcing it from a directly authenticated session
 *     (never from `X-Acting-For` delegation or an app/service token).
 *   - Fail-closed: `introspectGrant` returns `authorized: false` for every
 *     outcome other than a positive, unexpired, unrevoked, audience-matching
 *     row. A storage error propagates as a rejected promise rather than
 *     resolving `true` — the caller (the internal route) is responsible for
 *     translating that into a denial, never a silent allow.
 *   - Per-capability revocation never touches sibling capabilities or the
 *     parent grant; whole-grant revocation is a distinct, explicit action.
 */
import { and, eq, gt, inArray, desc } from 'drizzle-orm';
import { db, delegationGrants, delegationGrantCapabilities, delegationGrantEvents } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { createLogger } from '@imajin/logger';
import {
  validateGrantCapabilities,
  isDelegationAudience,
  isOnBehalfOfChain,
  GRANT_DEFAULT_TTL,
  GRANT_MAX_TTL,
  type DelegationAudience,
  type DelegationGrant,
  type GrantScope,
} from '@imajin/auth';

const log = createLogger('kernel');

export interface LibError {
  error: string;
  status: number;
}

function clampTtlMs(ttlMs: number | undefined): number {
  const requested = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : GRANT_DEFAULT_TTL;
  return Math.min(requested, GRANT_MAX_TTL);
}

function toGrantRecord(row: {
  id: string;
  agentDid: string;
  delegatorDid: string;
  audience: unknown;
  onBehalfOf: unknown;
  issuedAt: Date;
  expiresAt: Date;
  status: string;
  revokedAt: Date | null;
}, capabilities: GrantScope[]): DelegationGrant {
  return {
    grantId: row.id,
    agentDid: row.agentDid,
    delegatorDid: row.delegatorDid,
    capabilities,
    audience: row.audience as DelegationAudience,
    expiry: row.expiresAt.toISOString(),
    issuedAt: row.issuedAt.toISOString(),
    revokedAt: row.status === 'revoked' ? (row.revokedAt ?? row.issuedAt).toISOString() : null,
    capabilityRevocations: [],
    onBehalfOf: Array.isArray(row.onBehalfOf) ? (row.onBehalfOf as string[]) : [],
  };
}

/** Grant lifecycle audit trail (#1887 grants-view read surface). Best-effort:
 * a logging failure must never unwind an otherwise-successful grant mutation. */
async function recordGrantEvent(params: {
  grantId: string;
  event: 'issued' | 'renewed' | 'revoked' | 'capability_revoked';
  actorDid: string;
  capability?: string;
}): Promise<void> {
  try {
    await db.insert(delegationGrantEvents).values({
      id: generateId('gevt'),
      grantId: params.grantId,
      event: params.event,
      capability: params.capability ?? null,
      actorDid: params.actorDid,
      createdAt: new Date(),
    });
  } catch (err) {
    log.error({ err: String(err), grantId: params.grantId, event: params.event }, 'Failed to record grant lifecycle event');
  }
}

export interface IssueGrantInput {
  delegatorDid: string;
  agentDid: string;
  capabilities: readonly string[];
  audience: unknown;
  onBehalfOf?: unknown;
  ttlMs?: number;
}

/**
 * Issue a new grant. `delegatorDid` MUST be sourced by the caller from a
 * directly authenticated principal session (#1882: "a grant is only ever
 * created by the delegator principal, never requested-and-auto-created by
 * the agent") — this function does not and cannot verify that on its own.
 */
export async function issueGrant(input: IssueGrantInput): Promise<{ grant: DelegationGrant } | LibError> {
  const { delegatorDid, agentDid } = input;
  if (!delegatorDid || !agentDid) {
    return { error: 'delegatorDid and agentDid are required', status: 400 };
  }
  if (agentDid === delegatorDid) {
    return { error: 'agentDid must differ from delegatorDid — a grant delegates to someone else', status: 400 };
  }

  const requested = Array.from(new Set(input.capabilities ?? []));
  if (requested.length === 0) {
    return { error: 'capabilities must be a non-empty array', status: 400 };
  }
  const { valid, invalid } = validateGrantCapabilities(requested);
  if (invalid.length > 0) {
    return { error: `Unknown capabilities: ${invalid.join(', ')}`, status: 400 };
  }

  if (!isDelegationAudience(input.audience)) {
    return {
      error: 'audience must be { type: "all" } or { type: "dids", values: [...] } with plausible, non-wildcard DIDs',
      status: 400,
    };
  }
  const audience = input.audience;

  const onBehalfOf = input.onBehalfOf ?? [];
  if (!isOnBehalfOfChain(onBehalfOf, delegatorDid, agentDid)) {
    return { error: 'onBehalfOf must be an array of distinct DIDs excluding delegatorDid and agentDid', status: 400 };
  }

  const ttlMs = clampTtlMs(input.ttlMs);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttlMs);
  const grantId = generateId('grant');

  await db.insert(delegationGrants).values({
    id: grantId,
    agentDid,
    delegatorDid,
    audience,
    onBehalfOf,
    issuedAt,
    expiresAt,
    status: 'active',
  });

  try {
    await db.insert(delegationGrantCapabilities).values(
      valid.map((capability) => ({ id: generateId('gcap'), grantId, capability, status: 'active' as const })),
    );
  } catch (err) {
    // The parent row must never outlive its capabilities — an orphaned grant
    // with zero capabilities would introspect as "no capability covers this",
    // which is safe, but is still dead state nobody asked for.
    await db.delete(delegationGrants).where(eq(delegationGrants.id, grantId)).catch(() => undefined);
    throw err;
  }

  log.info({ grantId, delegatorDid, agentDid, capabilities: valid }, 'Delegation grant issued');
  await recordGrantEvent({ grantId, event: 'issued', actorDid: delegatorDid });

  return {
    grant: toGrantRecord({ id: grantId, agentDid, delegatorDid, audience, onBehalfOf, issuedAt, expiresAt, status: 'active', revokedAt: null }, valid),
  };
}

/** Revoke the entire grant. Only the issuing delegator may do this. */
export async function revokeGrant(params: { grantId: string; requestedBy: string }): Promise<{ revoked: boolean } | LibError> {
  const [grant] = await db
    .select({ delegatorDid: delegationGrants.delegatorDid, status: delegationGrants.status })
    .from(delegationGrants)
    .where(eq(delegationGrants.id, params.grantId))
    .limit(1);

  if (!grant) return { error: 'Grant not found', status: 404 };
  if (grant.delegatorDid !== params.requestedBy) {
    return { error: 'Only the delegator may revoke this grant', status: 403 };
  }

  const result = await db
    .update(delegationGrants)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(delegationGrants.id, params.grantId), eq(delegationGrants.status, 'active')))
    .returning({ id: delegationGrants.id });

  if (result.length > 0) {
    await recordGrantEvent({ grantId: params.grantId, event: 'revoked', actorDid: params.requestedBy });
  }

  return { revoked: result.length > 0 };
}

/**
 * Revoke exactly one capability, leaving the rest of the grant (and every
 * other capability on it) untouched (#1882 item 4).
 */
export async function revokeGrantCapability(params: {
  grantId: string;
  capability: string;
  requestedBy: string;
}): Promise<{ revoked: boolean } | LibError> {
  const [grant] = await db
    .select({ delegatorDid: delegationGrants.delegatorDid })
    .from(delegationGrants)
    .where(eq(delegationGrants.id, params.grantId))
    .limit(1);

  if (!grant) return { error: 'Grant not found', status: 404 };
  if (grant.delegatorDid !== params.requestedBy) {
    return { error: 'Only the delegator may revoke this grant', status: 403 };
  }

  const result = await db
    .update(delegationGrantCapabilities)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(delegationGrantCapabilities.grantId, params.grantId),
        eq(delegationGrantCapabilities.capability, params.capability),
        eq(delegationGrantCapabilities.status, 'active'),
      ),
    )
    .returning({ id: delegationGrantCapabilities.id });

  if (result.length > 0) {
    await recordGrantEvent({ grantId: params.grantId, event: 'capability_revoked', actorDid: params.requestedBy, capability: params.capability });
  }

  return { revoked: result.length > 0 };
}

/**
 * Renew a grant's lease. Only the issuing delegator may renew, and only an
 * active (non-revoked) grant — a revoked grant is a deliberate act and must
 * be re-issued, never resurrected via renewal.
 */
export async function renewGrant(params: {
  grantId: string;
  requestedBy: string;
  ttlMs?: number;
}): Promise<{ grantId: string; expiresAt: string } | LibError> {
  const [grant] = await db
    .select({ delegatorDid: delegationGrants.delegatorDid, status: delegationGrants.status })
    .from(delegationGrants)
    .where(eq(delegationGrants.id, params.grantId))
    .limit(1);

  if (!grant) return { error: 'Grant not found', status: 404 };
  if (grant.delegatorDid !== params.requestedBy) {
    return { error: 'Only the delegator may renew this grant', status: 403 };
  }
  if (grant.status !== 'active') {
    return { error: 'A revoked grant cannot be renewed — issue a new one', status: 409 };
  }

  const expiresAt = new Date(Date.now() + clampTtlMs(params.ttlMs));

  await db
    .update(delegationGrants)
    .set({ expiresAt, updatedAt: new Date() })
    .where(eq(delegationGrants.id, params.grantId));

  await recordGrantEvent({ grantId: params.grantId, event: 'renewed', actorDid: params.requestedBy });

  return { grantId: params.grantId, expiresAt: expiresAt.toISOString() };
}

export interface IntrospectionResult {
  authorized: boolean;
  grantId?: string;
  delegatorDid?: string;
  agentDid?: string;
  expiresAt?: string;
  reason?: string;
}

/**
 * Resolve whether `agentDid` currently holds `capability`, optionally scoped
 * to `targetDid` via the grant's audience and/or narrowed to grants issued
 * by a specific `delegatorDid` (#1895, #1897 — verifying a self-asserted
 * `delegator_did` on an attestation requires exactly this: does THIS
 * claimed delegator, not merely some delegator, currently grant the agent
 * this capability). This is the execution-time enforcement point (#1882
 * item 5): it re-reads current storage on every call rather than trusting
 * any caller-held cache, so a revocation or expiry is visible on the very
 * next check.
 *
 * Fails closed: any outcome other than a positive, active, unexpired,
 * audience-matching (and, when supplied, delegator-matching) row returns
 * `authorized: false`. A storage error is NOT caught here — it propagates
 * so the route layer can distinguish "denied" from "the lookup itself
 * failed" and refuse to treat the latter as an allow.
 */
export async function introspectGrant(params: {
  agentDid: string;
  capability: string;
  targetDid?: string;
  delegatorDid?: string;
}): Promise<IntrospectionResult> {
  const { agentDid, capability, targetDid, delegatorDid } = params;
  if (!agentDid || !capability) {
    return { authorized: false, reason: 'agentDid and capability are required' };
  }

  const now = new Date();

  // Two narrow, single-table queries rather than a join: at grant-per-agent
  // scale this is simpler to reason about (and to test) than a join, and
  // still hits the (agent_did, status) and (grant_id, capability, status)
  // indexes directly.
  const activeGrants = await db
    .select({
      grantId: delegationGrants.id,
      delegatorDid: delegationGrants.delegatorDid,
      audience: delegationGrants.audience,
      expiresAt: delegationGrants.expiresAt,
    })
    .from(delegationGrants)
    .where(
      and(
        eq(delegationGrants.agentDid, agentDid),
        eq(delegationGrants.status, 'active'),
        gt(delegationGrants.expiresAt, now),
        ...(delegatorDid ? [eq(delegationGrants.delegatorDid, delegatorDid)] : []),
      ),
    );

  if (activeGrants.length === 0) {
    return { authorized: false, reason: 'No active, unexpired grant covers this capability and audience' };
  }

  const grantIds = activeGrants.map((g: { grantId: string }) => g.grantId);
  const activeCapabilityRows = await db
    .select({ grantId: delegationGrantCapabilities.grantId })
    .from(delegationGrantCapabilities)
    .where(
      and(
        inArray(delegationGrantCapabilities.grantId, grantIds),
        eq(delegationGrantCapabilities.capability, capability),
        eq(delegationGrantCapabilities.status, 'active'),
      ),
    );
  const grantsWithCapability = new Set(activeCapabilityRows.map((row: { grantId: string }) => row.grantId));

  for (const grant of activeGrants) {
    if (!grantsWithCapability.has(grant.grantId)) continue;
    const audience = grant.audience as DelegationAudience;
    if (audience.type === 'dids' && (!targetDid || !audience.values.includes(targetDid))) continue;

    // Grants-view read surface (#1887): lastUsedAt is the honest "did this
    // grant actually do anything" signal. Best-effort — a logging failure
    // must never turn a real authorization into a denial.
    db.update(delegationGrants)
      .set({ lastUsedAt: new Date() })
      .where(eq(delegationGrants.id, grant.grantId))
      .catch((err: unknown) => log.error({ err: String(err), grantId: grant.grantId }, 'Failed to record grant lastUsedAt'));

    return {
      authorized: true,
      grantId: grant.grantId,
      delegatorDid: grant.delegatorDid,
      agentDid,
      expiresAt: grant.expiresAt.toISOString(),
    };
  }

  return { authorized: false, reason: 'No active, unexpired grant covers this capability and audience' };
}

/** List a delegator's own grants, most recently issued first. */
export async function listGrantsForDelegator(delegatorDid: string): Promise<DelegationGrant[]> {
  const grantRows = await db
    .select()
    .from(delegationGrants)
    .where(eq(delegationGrants.delegatorDid, delegatorDid));

  if (grantRows.length === 0) return [];

  const capabilityRows = await db
    .select({
      grantId: delegationGrantCapabilities.grantId,
      capability: delegationGrantCapabilities.capability,
      status: delegationGrantCapabilities.status,
    })
    .from(delegationGrantCapabilities)
    .where(inArray(delegationGrantCapabilities.grantId, grantRows.map((row: { id: string }) => row.id)));

  const capabilitiesByGrant = new Map<string, GrantScope[]>();
  for (const row of capabilityRows) {
    if (row.status !== 'active') continue;
    const list = capabilitiesByGrant.get(row.grantId) ?? [];
    list.push(row.capability as GrantScope);
    capabilitiesByGrant.set(row.grantId, list);
  }

  return grantRows
    .map((row: Parameters<typeof toGrantRecord>[0]) => toGrantRecord(row, capabilitiesByGrant.get(row.id) ?? []))
    .sort((a: DelegationGrant, b: DelegationGrant) => b.issuedAt.localeCompare(a.issuedAt));
}

export type GrantStatusLabel = 'active' | 'expiring' | 'expired' | 'revoked';

/** A grant is "expiring" inside this window — a UI nudge to renew, not an enforcement boundary. */
const EXPIRING_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

export function grantStatusLabel(params: { status: string; expiresAt: string; now?: Date }): GrantStatusLabel {
  if (params.status === 'revoked') return 'revoked';
  const now = params.now ?? new Date();
  const expiresAt = new Date(params.expiresAt).getTime();
  if (expiresAt <= now.getTime()) return 'expired';
  if (expiresAt - now.getTime() <= EXPIRING_SOON_WINDOW_MS) return 'expiring';
  return 'active';
}

export interface GrantCapabilityDetail {
  capability: GrantScope;
  status: 'active' | 'revoked';
  revokedAt: string | null;
}

export interface GrantEventDetail {
  event: 'issued' | 'renewed' | 'revoked' | 'capability_revoked';
  capability: string | null;
  actorDid: string;
  createdAt: string;
}

export interface DelegationGrantDetail {
  grantId: string;
  agentDid: string;
  delegatorDid: string;
  audience: DelegationAudience;
  onBehalfOf: string[];
  issuedAt: string;
  expiresAt: string;
  status: GrantStatusLabel;
  revokedAt: string | null;
  lastUsedAt: string | null;
  capabilities: GrantCapabilityDetail[];
  history: GrantEventDetail[];
}

/**
 * List a delegator's grants with the full grants-view read-surface detail
 * (#1887 pinned comment): every capability regardless of status (so revoked
 * scopes still render as chips, not disappear), lastUsedAt, and lifecycle
 * history. Revoked/expired grants are included, not filtered out — "the
 * record doesn't disappear because the authority did".
 */
export async function listGrantDetailsForDelegator(delegatorDid: string): Promise<DelegationGrantDetail[]> {
  const grantRows = await db
    .select()
    .from(delegationGrants)
    .where(eq(delegationGrants.delegatorDid, delegatorDid));

  if (grantRows.length === 0) return [];

  const grantIds = grantRows.map((row: { id: string }) => row.id);

  const capabilityRows = await db
    .select({
      grantId: delegationGrantCapabilities.grantId,
      capability: delegationGrantCapabilities.capability,
      status: delegationGrantCapabilities.status,
      revokedAt: delegationGrantCapabilities.revokedAt,
    })
    .from(delegationGrantCapabilities)
    .where(inArray(delegationGrantCapabilities.grantId, grantIds));

  const capabilitiesByGrant = new Map<string, GrantCapabilityDetail[]>();
  for (const row of capabilityRows) {
    const list = capabilitiesByGrant.get(row.grantId) ?? [];
    list.push({
      capability: row.capability as GrantScope,
      status: row.status as 'active' | 'revoked',
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    });
    capabilitiesByGrant.set(row.grantId, list);
  }

  const eventRows = await db
    .select({
      grantId: delegationGrantEvents.grantId,
      event: delegationGrantEvents.event,
      capability: delegationGrantEvents.capability,
      actorDid: delegationGrantEvents.actorDid,
      createdAt: delegationGrantEvents.createdAt,
    })
    .from(delegationGrantEvents)
    .where(inArray(delegationGrantEvents.grantId, grantIds))
    .orderBy(desc(delegationGrantEvents.createdAt));

  const historyByGrant = new Map<string, GrantEventDetail[]>();
  for (const row of eventRows) {
    const list = historyByGrant.get(row.grantId) ?? [];
    list.push({
      event: row.event as GrantEventDetail['event'],
      capability: row.capability ?? null,
      actorDid: row.actorDid,
      createdAt: row.createdAt.toISOString(),
    });
    historyByGrant.set(row.grantId, list);
  }

  return grantRows
    .map((row: typeof grantRows[number]) => {
      const expiresAt = row.expiresAt.toISOString();
      return {
        grantId: row.id,
        agentDid: row.agentDid,
        delegatorDid: row.delegatorDid,
        audience: row.audience as DelegationAudience,
        onBehalfOf: Array.isArray(row.onBehalfOf) ? (row.onBehalfOf as string[]) : [],
        issuedAt: row.issuedAt.toISOString(),
        expiresAt,
        status: grantStatusLabel({ status: row.status, expiresAt }),
        revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
        lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
        capabilities: capabilitiesByGrant.get(row.id) ?? [],
        history: historyByGrant.get(row.id) ?? [],
      };
    })
    .sort((a: DelegationGrantDetail, b: DelegationGrantDetail) => b.issuedAt.localeCompare(a.issuedAt));
}
