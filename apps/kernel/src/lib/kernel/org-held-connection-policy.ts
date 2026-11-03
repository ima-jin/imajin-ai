import { and, eq, isNull } from 'drizzle-orm';
import { identities, identityMembers } from '@/src/db';
import type { ConnectionTransaction } from './member-connection-gate';
import { ExternalMcpError } from './external-mcp-policy';

export const ORG_HELD_PREFIX = 'org-held-';
export const orgHeldProvider = (provider: string) => `${ORG_HELD_PREFIX}${provider}`;
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
    || person?.scope !== 'actor' || person.subtype === 'agent' || person.suspendedAt
    || !membership || !['owner', 'admin'].includes(membership.role)
    || (membership.allowedServices !== null && !membership.allowedServices.includes('connections'))) {
    throw new ExternalMcpError(403, 'Active organization owner or admin required');
  }
}
