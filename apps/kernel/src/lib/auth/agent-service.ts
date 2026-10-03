/**
 * The `actor/agent` DID and its `serviceOf` relation (#2407, RFC-31 v2 Phase 1,
 * epic #1758).
 *
 * An agent is a first-class DID — `scope='actor'`, `subtype='agent'` — that is
 * in service of one or more principal DIDs (many agents per principal, many
 * principals per agent). That relation is the binding between a principal and
 * the harness instance running its agent: the kernel addresses the agent DID,
 * never a gateway, and where the instance runs is a property of the live
 * connection, not of the identity.
 *
 * ## There is no new authority here
 *
 * `serviceOf` is a READ-ONLY VIEW over rows that already exist: an active
 * `identity_members` row with `role='agent'` on the principal, whose member is
 * an `actor/agent` identity. That is the exact row `agent-authority.ts`'s
 * membership path already reads. This module writes nothing, issues no
 * grants, and is never consulted by `resolveAgentAuthority` / `requireAuth` —
 * so being listed here (or being an `actor/agent`) confers no capability that
 * the existing delegation machinery doesn't already grant by itself. A
 * `role='agent'` row whose member is NOT an `actor/agent` (a forged or stale
 * row), a removed row, and a suspended agent are all excluded from the view.
 *
 * Callers own the access decision (who may see a principal's agents) — see
 * `GET /auth/api/identity/:did/agents` and the `serviceOf` field on
 * `GET /auth/api/identity/:did`.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, identities, identityMembers } from '@/src/db';
import { getDidConnectionStates, type DidConnectionState } from './did-connections';

/** The identity scope/subtype pair that makes a DID an agent. */
export const AGENT_SCOPE = 'actor';
export const AGENT_SUBTYPE = 'agent';

/** The identity_members role that binds an agent to a principal — the same role `agent-authority.ts` reads. */
export const SERVICE_ROLE = 'agent';

export interface ServingAgent {
  did: string;
  handle: string | null;
  name: string | null;
  /** When the principal's `role='agent'` row was added (ISO-8601), if recorded. */
  servingSince: string | null;
}

export interface ServingAgentView extends ServingAgent {
  scope: typeof AGENT_SCOPE;
  subtype: typeof AGENT_SUBTYPE;
  connection: { state: DidConnectionState };
}

/**
 * The active, non-suspended `actor/agent` DIDs that `principalDid` has bound
 * as its agents, oldest binding first. Duplicate membership rows collapse to
 * one entry (`identity_members` has no unique constraint on the pair).
 */
export async function listServingAgents(principalDid: string): Promise<ServingAgent[]> {
  const rows = await db
    .select({
      did: identities.id,
      handle: identities.handle,
      name: identities.name,
      addedAt: identityMembers.addedAt,
    })
    .from(identityMembers)
    .innerJoin(identities, eq(identityMembers.memberDid, identities.id))
    .where(
      and(
        eq(identityMembers.identityDid, principalDid),
        eq(identityMembers.role, SERVICE_ROLE),
        isNull(identityMembers.removedAt),
        eq(identities.scope, AGENT_SCOPE),
        eq(identities.subtype, AGENT_SUBTYPE),
        isNull(identities.suspendedAt),
      ),
    )
    .orderBy(asc(identityMembers.addedAt));

  const seen = new Set<string>();
  const agents: ServingAgent[] = [];
  for (const row of rows) {
    if (row.did === principalDid || seen.has(row.did)) continue;
    seen.add(row.did);
    agents.push({
      did: row.did,
      handle: row.handle,
      name: row.name,
      servingSince: row.addedAt ? new Date(row.addedAt).toISOString() : null,
    });
  }
  return agents;
}

/**
 * `serviceOf` for `agentDid`: the principal DIDs that have bound it as an
 * agent. Empty when `agentDid` is not an active `actor/agent` — a DID of any
 * other subtype serves nobody, whatever rows name it.
 */
export async function listServiceOf(agentDid: string): Promise<string[]> {
  const rows = await db
    .select({ principalDid: identityMembers.identityDid })
    .from(identityMembers)
    .innerJoin(identities, eq(identityMembers.memberDid, identities.id))
    .where(
      and(
        eq(identityMembers.memberDid, agentDid),
        eq(identityMembers.role, SERVICE_ROLE),
        isNull(identityMembers.removedAt),
        eq(identities.scope, AGENT_SCOPE),
        eq(identities.subtype, AGENT_SUBTYPE),
        isNull(identities.suspendedAt),
      ),
    );

  return [...new Set(rows.map((row: { principalDid: string }) => row.principalDid))].filter(
    (principalDid) => principalDid !== agentDid,
  );
}

/**
 * Resolve a principal DID to its serving agent DID(s) and each one's live
 * harness connection — the lookup #2251's router and #2288's console consume.
 * Connection state is the agent DID's own authenticated WebSocket (the
 * plugin's outbound connection); see `did-connections.ts` for `unknown`.
 */
export async function resolveServingAgents(principalDid: string): Promise<ServingAgentView[]> {
  const agents = await listServingAgents(principalDid);
  const states = await getDidConnectionStates(agents.map((agent) => agent.did));
  return agents.map((agent) => ({
    ...agent,
    scope: AGENT_SCOPE,
    subtype: AGENT_SUBTYPE,
    connection: { state: states.get(agent.did) ?? 'unknown' },
  }));
}
