import { and, eq, isNull } from 'drizzle-orm';
import { db, identities, identityMembers } from '@/src/db';
import { OwnershipError } from './ownership-policy';

/** Share the transfer lock: a stale role check can never remove the new owner. */
export async function removeGroupController(groupDid: string, callerDid: string, controllerDid: string) {
  await db.transaction(async (tx) => {
    await tx.select({ id: identities.id }).from(identities).where(eq(identities.id, groupDid)).for('update');
    const rows = await tx.select().from(identityMembers)
      .where(and(eq(identityMembers.identityDid, groupDid), isNull(identityMembers.removedAt)));
    const caller = rows.find((member) => member.memberDid === callerDid);
    const target = rows.find((member) => member.memberDid === controllerDid);
    if (!caller || !['owner', 'admin'].includes(caller.role)) {
      throw new OwnershipError('Must be owner or admin to remove controllers', 403);
    }
    if (!target) throw new OwnershipError('Controller not found', 404);
    if (target.role === 'owner') throw new OwnershipError('Owner cannot be removed; transfer ownership first', 400);
    const leaving = callerDid === controllerDid;
    if (caller.role === 'admin' && !leaving && target.role !== 'member') {
      throw new OwnershipError('Admin can only remove members', 403);
    }
    await tx.update(identityMembers).set({ removedAt: new Date() }).where(
      and(eq(identityMembers.identityDid, groupDid), eq(identityMembers.memberDid, controllerDid)),
    );
  });
}
