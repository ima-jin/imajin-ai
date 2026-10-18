import { and, eq, isNull, or } from 'drizzle-orm';
import type { Identity } from '@imajin/auth';
import { evaluateDelegationPolicy } from '@imajin/auth/delegation-policy';
import { db, identities, identityMembers, connections, attestations } from '@/src/db';
import type { RelationshipLabel } from '@/src/db/schemas/connections';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Actor = Pick<Identity, 'id' | 'actingFor' | 'actingAs'>;

export class RelationshipLabelError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export const relationshipLabelMutation = {
  action: 'relationship-label', class: 'reversible',
  gatedUntil: 'org controller delegation with signed actor provenance is supported',
} as const;

export function isRelationshipLabel(value: unknown): value is RelationshipLabel | null {
  return value === null || ['client', 'vendor', 'partner', 'other'].includes(value as string);
}

/** Read live authority, not cached act-as claims or the effective org DID itself. */
async function hasControllerAuthority(tx: Transaction, orgDid: string, actor: Actor): Promise<boolean> {
  if (!evaluateDelegationPolicy(actor, relationshipLabelMutation).allowed) return false;
  const [org] = await tx.select({ scope: identities.scope, suspendedAt: identities.suspendedAt })
    .from(identities).where(eq(identities.id, orgDid)).for('share');
  if (org?.scope !== 'business' || org.suspendedAt) return false;
  const [originalActor] = await tx.select({ scope: identities.scope, subtype: identities.subtype, suspendedAt: identities.suspendedAt })
    .from(identities).where(eq(identities.id, actor.id)).for('share');
  if (originalActor?.scope !== 'actor' || originalActor.subtype === 'agent' || originalActor.suspendedAt) return false;
  const members = await tx.select({ role: identityMembers.role, allowedServices: identityMembers.allowedServices })
    .from(identityMembers).where(and(
      eq(identityMembers.identityDid, orgDid), eq(identityMembers.memberDid, actor.id),
      isNull(identityMembers.removedAt),
    )).for('share');
  if (members.length !== 1) return false;
  const member = members[0];
  return ['owner', 'admin'].includes(member.role)
    && (!member.allowedServices?.length || member.allowedServices.includes('connections'));
}

export function canManageRelationshipLabels(orgDid: string, actor: Actor): Promise<boolean> {
  return db.transaction((tx) => hasControllerAuthority(tx, orgDid, actor));
}

/** Lock the active bilateral row so old→new provenance is serialized and atomic. */
export function setRelationshipLabel(
  orgDid: string, counterpartyDid: string, actor: Actor, relationshipLabel: RelationshipLabel | null,
) {
  return db.transaction(async (tx) => {
    if (!await hasControllerAuthority(tx, orgDid, actor)) {
      throw new RelationshipLabelError('Must be an active business owner or admin with connections access', 403);
    }
    const where = and(
      or(
        and(eq(connections.didA, orgDid), eq(connections.didB, counterpartyDid)),
        and(eq(connections.didB, orgDid), eq(connections.didA, counterpartyDid)),
      ),
      isNull(connections.disconnectedAt),
    );
    const [connection] = await tx.select().from(connections).where(where).for('update');
    if (!connection) throw new RelationshipLabelError('Active connection not found', 404);
    const ownSide = connection.didA === orgDid ? 'relationshipLabelA' : 'relationshipLabelB';
    const oldLabel = connection[ownSide];
    if (oldLabel === relationshipLabel) return { did: counterpartyDid, relationshipLabel };
    const attestation = await prepareMechanicalAttestation({
      type: 'connection.relationship.label.changed', subjectDid: orgDid,
      contextId: orgDid, contextType: 'connection',
      payload: {
        orgDid, counterpartyDid, actorDid: actor.id, oldLabel, newLabel: relationshipLabel,
        disclosure_scope: 'parties',
      },
    });
    await tx.update(connections).set({ [ownSide]: relationshipLabel }).where(where);
    await tx.insert(attestations).values({ ...attestation, disclosureScope: 'parties' });
    return { did: counterpartyDid, relationshipLabel, attestationId: attestation.id };
  });
}
