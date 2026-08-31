/**
 * Dual-read resolution for agent delegation authority (#1887 migration step
 * 3, RFC #1881).
 *
 * Historically, "does agentDid act for principalDid" was answered by a
 * single membership check: an active (not-removed) role='agent' row in
 * auth.identity_members (see POST /auth/api/internal/verify-delegation,
 * historically membership-only). #1882 introduced scoped delegation_grants
 * as the target authority model. This module is the dual-read window
 * described in #1887's migration sketch:
 *
 *   1. Grants first: does agentDid hold ANY active, unexpired grant issued
 *      by principalDid, regardless of which specific capability is
 *      eventually exercised? This is the coarse bootstrap gate that decides
 *      whether X-Acting-For / register_also may proceed at all.
 *      Capability-specific enforcement for individual actions is a separate,
 *      narrower concern handled by introspectGrant() (#1882) at the routes
 *      that have been migrated to check it.
 *   2. Membership fallback, logged: if no grant is found, fall back to the
 *      pre-#1887 membership check so existing agents (backfilled with a wide
 *      grant by migration 0104, or not yet backfilled for any reason) are
 *      never cut off mid-migration. Every fallback is logged so the flip to
 *      grants-only (step 4 of the migration sketch, out of scope for #1887)
 *      can be scheduled once fallback traffic reaches zero.
 *
 * Rollback: set AGENT_AUTHORITY_MODE=membership-only to disable the
 * grants-first path outright and revert to the pre-#1887 membership-only
 * check without deploying different code — the flag *is* the rollback
 * switch for this dual-read window.
 *
 * Fails closed: a storage error propagates as a rejected promise rather
 * than resolving to `allowed: true` — callers (the internal route, and
 * requireAuth's X-Acting-For branch) are responsible for treating a lookup
 * failure as a denial, never a silent allow.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, identityMembers, delegationGrants } from '@/src/db';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/** The identity_members role that lets one DID act on another's behalf. */
const AGENT_ROLE = 'agent';

export type AgentAuthorityMode = 'grants-first' | 'membership-only';

/** Reads the dual-read flag fresh on every call so tests/ops can flip it live. */
export function agentAuthorityMode(): AgentAuthorityMode {
  return process.env.AGENT_AUTHORITY_MODE === 'membership-only' ? 'membership-only' : 'grants-first';
}

export type AgentAuthorityVia = 'grant' | 'membership' | 'none';

export interface AgentAuthorityResult {
  allowed: boolean;
  via: AgentAuthorityVia;
  grantId?: string;
}

async function hasActiveMembership(agentDid: string, principalDid: string): Promise<boolean> {
  const [membership] = await db
    .select({ memberDid: identityMembers.memberDid })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, principalDid),
        eq(identityMembers.memberDid, agentDid),
        eq(identityMembers.role, AGENT_ROLE),
        isNull(identityMembers.removedAt),
      ),
    )
    .limit(1);
  return Boolean(membership);
}

/**
 * Does agentDid hold ANY active, unexpired grant from principalDid,
 * regardless of specific capability? Deliberately coarse — this answers
 * "may this agent act for this principal at all", not "may it exercise a
 * particular capability" (that is introspectGrant's job).
 */
async function activeGrantFromDelegator(agentDid: string, principalDid: string): Promise<string | null> {
  const now = new Date();
  const [grant] = await db
    .select({ id: delegationGrants.id })
    .from(delegationGrants)
    .where(
      and(
        eq(delegationGrants.agentDid, agentDid),
        eq(delegationGrants.delegatorDid, principalDid),
        eq(delegationGrants.status, 'active'),
        gt(delegationGrants.expiresAt, now),
      ),
    )
    .limit(1);
  return grant?.id ?? null;
}

/**
 * Resolve whether `agentDid` may act for `principalDid`, per the #1887
 * dual-read window. Shared by POST /auth/api/internal/verify-delegation
 * (called by ws-server.js for register_also, and by packages/auth's
 * requireAuth for the X-Acting-For bootstrap) so both call sites migrate to
 * grants-first resolution in one place.
 */
export async function resolveAgentAuthority(agentDid: string, principalDid: string): Promise<AgentAuthorityResult> {
  const mode = agentAuthorityMode();

  if (mode === 'membership-only') {
    const allowed = await hasActiveMembership(agentDid, principalDid);
    return allowed ? { allowed: true, via: 'membership' } : { allowed: false, via: 'none' };
  }

  const grantId = await activeGrantFromDelegator(agentDid, principalDid);
  if (grantId) {
    return { allowed: true, via: 'grant', grantId };
  }

  const allowedViaMembership = await hasActiveMembership(agentDid, principalDid);
  if (allowedViaMembership) {
    log.warn(
      { agentDid, principalDid },
      '[agent-authority] Resolved via role:agent membership fallback (#1887 dual-read) — no active grant found',
    );
    return { allowed: true, via: 'membership' };
  }

  return { allowed: false, via: 'none' };
}
