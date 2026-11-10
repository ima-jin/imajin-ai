import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, connectors, identities, identityMembers } from '@/src/db';
import { ExternalMcpError } from './external-mcp-policy';
import { isAgentCapableSubtype } from './connection-principal-policy';
import type { OrgConnectionActor } from './org-held-connection-policy';
import { connectorPurpose, connectorVendor, isHeldBy, isUpstreamConnection } from './connection-holding';

/** Membership permits metadata only. It does not create a custody or member grant. */
export function readOrgHeldStatus(actor: OrgConnectionActor) {
  return db.transaction(async tx => {
    const [org] = await tx.select({ scope: identities.scope, suspendedAt: identities.suspendedAt })
      .from(identities).where(eq(identities.id, actor.orgDid)).for('share');
    const [person] = await tx.select({ scope: identities.scope, subtype: identities.subtype, suspendedAt: identities.suspendedAt })
      .from(identities).where(eq(identities.id, actor.actorDid)).for('share');
    const [membership] = await tx.select({ memberDid: identityMembers.memberDid })
      .from(identityMembers).where(and(
        eq(identityMembers.identityDid, actor.orgDid), eq(identityMembers.memberDid, actor.actorDid),
        isNull(identityMembers.removedAt),
      )).for('share');
    if (!org || !['business', 'community', 'family'].includes(org.scope) || org.suspendedAt
      || person?.scope !== 'actor' || isAgentCapableSubtype(person.subtype) || person.suspendedAt || !membership) {
      throw new ExternalMcpError(403, 'Active organization membership required');
    }
    const rows = await tx.select({
      ownerDid: connectors.ownerDid, provider: connectors.provider,
      upstreamBinding: connectors.upstreamBinding, loadedAt: connectors.loadedAt,
    })
      .from(connectors).where(and(
        eq(connectors.ownerDid, actor.orgDid),
        eq(connectors.slot, 'primary'), eq(connectors.status, 'active'),
        isNotNull(connectors.sealedKeyField), isNotNull(connectors.loadedAt), isNotNull(connectors.loadedByDid),
      )).orderBy(connectors.provider);
    return { connections: rows.filter(row => isHeldBy(row, actor.orgDid)
      && connectorPurpose(row) === 'inference' && !isUpstreamConnection(row)).map(row => ({
      provider: connectorVendor(row),
      status: 'loaded' as const, loadedAt: row.loadedAt,
    })) };
  });
}
