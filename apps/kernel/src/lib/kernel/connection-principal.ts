import { and, eq, gt, isNull } from 'drizzle-orm';
import { audienceAllows, isDelegationAudience } from '@imajin/auth';
import { db, delegationGrants, identities, identityMembers } from '@/src/db';
import { ExternalMcpError } from './external-mcp-policy';
import type { ConnectionTransaction } from './member-connection-gate';
import { isAgentCapableSubtype, isOrgScope, type ConnectionCaller } from './connection-principal-policy';
export { missingConnection, type ConnectionCaller } from './connection-principal-policy';
type Reader = Pick<ConnectionTransaction, 'select'>;
const forbidden = (code: 'agent_not_assigned' | 'service_not_allowed' | 'identity_inactive' = 'agent_not_assigned') =>
  new ExternalMcpError(403, 'Agent is not assigned to this identity or service', code);

/** An explicit service restriction cannot be bypassed by a parallel delegation grant. */
export async function requireAgentAssignment(tx: Reader, agentDid: string, principalDid: string, service: string) {
  const [membership] = await tx.select().from(identityMembers).where(and(
    eq(identityMembers.identityDid, principalDid), eq(identityMembers.memberDid, agentDid),
    isNull(identityMembers.removedAt),
  )).limit(1);
  if (membership?.allowedServices !== null && membership?.allowedServices !== undefined
    && !membership.allowedServices.includes(service)) throw forbidden('service_not_allowed');
  if (membership?.role === 'agent') return;
  const grants = await tx.select().from(delegationGrants).where(and(
    eq(delegationGrants.agentDid, agentDid), eq(delegationGrants.delegatorDid, principalDid),
    eq(delegationGrants.status, 'active'), isNull(delegationGrants.revokedAt),
    gt(delegationGrants.expiresAt, new Date()),
  ));
  if (!grants.some(grant => isDelegationAudience(grant.audience) && audienceAllows(grant.audience, principalDid))) {
    throw forbidden();
  }
}

async function activeIdentity(tx: Reader, did: string) {
  const [identity] = await tx.select().from(identities).where(and(
    eq(identities.id, did), isNull(identities.suspendedAt),
  )).limit(1);
  if (!identity) throw forbidden('identity_inactive');
  return identity;
}

/** Re-read assignment on every call; org membership never becomes a member key grant. */
export async function resolveConnectionPrincipal(caller: ConnectionCaller, service: string, tx: Reader = db) {
  if (!caller.actingFor && !caller.actingAs) return { ownerDid: caller.actorDid, actorDid: caller.actorDid };
  const actor = await activeIdentity(tx, caller.actorDid);
  const principalDid = caller.actingFor ?? caller.actingAs ?? caller.actorDid;
  const principal = principalDid === caller.actorDid ? actor : await activeIdentity(tx, principalDid);
  const delegated = principalDid !== caller.actorDid;
  if (isAgentCapableSubtype(actor.subtype) && delegated) {
    await requireAgentAssignment(tx, caller.actorDid, principalDid, service);
  } else if (caller.actingFor && delegated) {
    throw forbidden();
  }
  const orgDid = caller.actingAs ?? (isOrgScope(principal.scope) ? principalDid : undefined);
  if (orgDid && orgDid !== principalDid) await activeIdentity(tx, orgDid);
  return principalContext(caller, actor.subtype, principalDid, orgDid);
}

function principalContext(caller: ConnectionCaller, subtype: string | null, principalDid: string, orgDid?: string) {
  const assignedAgentDid = isAgentCapableSubtype(subtype) && caller.actorDid !== principalDid && principalDid === orgDid ? caller.actorDid : undefined;
  return {
    ownerDid: orgDid ?? principalDid,
    actorDid: caller.actorDid,
    ...(orgDid ? { orgContext: {
      memberDid: principalDid === orgDid ? caller.actorDid : principalDid,
      orgDid,
      ...(assignedAgentDid ? { assignedAgentDid } : {}),
    } } : {}),
  };
}
