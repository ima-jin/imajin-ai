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
import { and, eq, gt, inArray } from 'drizzle-orm';
import { db, delegationGrants, delegationGrantCapabilities } from '@/src/db';
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
 * to `targetDid` via the grant's audience. This is the execution-time
 * enforcement point (#1882 item 5): it re-reads current storage on every
 * call rather than trusting any caller-held cache, so a revocation or expiry
 * is visible on the very next check.
 *
 * Fails closed: any outcome other than a positive, active, unexpired,
 * audience-matching row returns `authorized: false`. A storage error is
 * NOT caught here — it propagates so the route layer can distinguish "denied"
 * from "the lookup itself failed" and refuse to treat the latter as an allow.
 */
export async function introspectGrant(params: {
  agentDid: string;
  capability: string;
  targetDid?: string;
}): Promise<IntrospectionResult> {
  const { agentDid, capability, targetDid } = params;
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
