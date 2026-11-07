import { and, eq, isNull } from 'drizzle-orm';
import { identities, identityMembers } from '@/src/db';
import type { ConnectionTransaction } from './member-connection-gate';
import { ExternalMcpError } from './external-mcp-policy';
import { isAgentCapableSubtype } from './connection-principal-policy';

export const isOrgSealedAnthropicField = (ownerDid: string, field: string | null) =>
  field === `anthropic-api-key:${ownerDid}`;
export interface OrgConnectionActor { orgDid: string; actorDid: string }

/** The org lock serializes grant changes with canonical membership removal. */
export async function authorizeOrgConnectionAdmin(
  tx: ConnectionTransaction, actor: OrgConnectionActor, lock: 'share' | 'update' = 'share',
) {
  const [org] = await tx.select().from(identities).where(eq(identities.id, actor.orgDid)).for(lock);
  const [person] = await tx.select().from(identities).where(eq(identities.id, actor.actorDid)).for('share');
  const [membership] = await tx.select().from(identityMembers).where(and(
    eq(identityMembers.identityDid, actor.orgDid), eq(identityMembers.memberDid, actor.actorDid),
    isNull(identityMembers.removedAt),
  )).for('share');
  if (!org || !['business', 'community', 'family'].includes(org.scope) || org.suspendedAt
    || person?.scope !== 'actor' || isAgentCapableSubtype(person.subtype) || person.suspendedAt
    || !membership || !['owner', 'admin'].includes(membership.role)
    || (membership.allowedServices !== null && !membership.allowedServices.includes('connections'))) {
    throw new ExternalMcpError(403, 'Active organization owner or admin required');
  }
}
