import { and, eq, isNull } from 'drizzle-orm';
import { db, identities, identityMembers } from '@/src/db';
import { ASSIGNABLE_MEMBER_ROLES } from './membership';
import { OwnershipError } from './ownership-policy';
import { recordMemberEvent, type MemberActor } from './member-attestation';
import { parseMemberServices } from './member-service-scope';

function parseUpdate(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OwnershipError('Expected a membership update object', 400);
  }
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['role', 'allowedServices'].includes(key))
    || Object.keys(value).length === 0) {
    throw new OwnershipError('Provide role and/or allowedServices only', 400);
  }
  if (value.role !== undefined && !(ASSIGNABLE_MEMBER_ROLES as readonly unknown[]).includes(value.role)) {
    throw new OwnershipError('Invalid role; use ownership transfer to change owners', 400);
  }
  const allowedServices = value.allowedServices === undefined
    ? undefined : parseMemberServices(value.allowedServices);
  return { role: value.role as string | undefined, allowedServices };
}

export function updateGroupMember(groupDid: string, actor: MemberActor, memberDid: string, body: unknown) {
  const input = parseUpdate(body);
  return db.transaction(async (tx) => {
    // Same lock as add/remove and #2892: no stale membership or owner mutations.
    const [group] = await tx.select().from(identities).where(eq(identities.id, groupDid)).for('update');
    if (!group || !['business', 'community', 'family'].includes(group.scope)) {
      throw new OwnershipError('Group not found', 404);
    }
    if (group.suspendedAt) throw new OwnershipError('Group suspended', 403);
    const rows = await tx.select().from(identityMembers)
      .where(and(eq(identityMembers.identityDid, groupDid), isNull(identityMembers.removedAt)));
    const caller = rows.find((member) => member.memberDid === actor.id);
    const target = rows.find((member) => member.memberDid === memberDid);
    if (!caller || !['owner', 'admin'].includes(caller.role)) {
      throw new OwnershipError('Must be owner or admin to edit members', 403);
    }
    if (!target) throw new OwnershipError('Member not found', 404);
    if (target.role === 'owner') throw new OwnershipError('Use ownership transfer to change owners', 400);
    const role = input.role ?? target.role;
    // Same add boundary (only owner grants admin), and remove boundary for targets.
    if (caller.role === 'admin' && (role === 'admin'
      || (target.role !== 'member' && actor.id !== memberDid))) {
      throw new OwnershipError('Admin can only edit members and cannot grant admin', 403);
    }
    const services = input.allowedServices === undefined ? target.allowedServices : input.allowedServices;
    const allowedServices = services === null
      ? null : [...new Set(services)].sort((a, b) => a.localeCompare(b));
    const oldServices = target.allowedServices
      ? [...target.allowedServices].sort((a, b) => a.localeCompare(b)) : null;
    if (role === target.role && JSON.stringify(oldServices) === JSON.stringify(allowedServices)) {
      return { ok: true, memberDid, role, allowedServices, changed: false };
    }
    const attestationId = await recordMemberEvent(tx, 'group.member.role.changed', groupDid, memberDid, actor, {
      oldRole: target.role, newRole: role,
      oldAllowedServices: target.allowedServices, allowedServices,
    });
    await tx.update(identityMembers).set({ role, allowedServices }).where(
      and(eq(identityMembers.identityDid, groupDid), eq(identityMembers.memberDid, memberDid), isNull(identityMembers.removedAt)),
    );
    return { ok: true, memberDid, role, allowedServices, changed: true, attestationId };
  });
}
