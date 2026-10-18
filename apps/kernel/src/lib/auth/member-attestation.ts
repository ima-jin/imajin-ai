import type { Identity } from '@imajin/auth';
import { attestations, db } from '@/src/db';
import { prepareMechanicalAttestation } from './emit-mechanical-attestation';

export type MemberActor = Pick<Identity, 'id' | 'actingAs' | 'actingFor'>;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Membership changes and their node-signed evidence commit or roll back together. */
export async function recordMemberEvent(
  tx: Transaction,
  type: 'group.member.added' | 'group.member.role.changed' | 'group.member.removed',
  groupDid: string,
  memberDid: string,
  actor: MemberActor,
  payload: Record<string, unknown>,
) {
  const record = await prepareMechanicalAttestation({
    type, subjectDid: memberDid, contextId: groupDid, contextType: 'group',
    payload: {
      ...payload, memberDid, by: actor.id,
      actingAs: actor.actingAs ?? null, actingFor: actor.actingFor ?? null,
    },
  });
  await tx.insert(attestations).values(record);
  return record.id;
}
