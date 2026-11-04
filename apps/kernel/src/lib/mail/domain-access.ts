import { requireAuth } from '@imajin/auth';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, identities, identityMembers } from '@/src/db';

/** The route owner is explicit. X-Acting-For NEVER selects the organization. */
export async function requireMailDomainManager(request: Request, ownerDid: string) {
  const auth = await requireAuth(request, { sessionOnly: true });
  if ('error' in auth) return Response.json({ error: auth.error }, { status: auth.status });
  const caller = auth.identity;
  if (caller.actingAs && caller.actingAs !== ownerDid) {
    return Response.json({ error: 'Identity context does not match organization' }, { status: 403 });
  }
  const [actor] = await db.select({ subtype: identities.subtype }).from(identities).where(and(
    eq(identities.id, caller.id), isNull(identities.suspendedAt),
  )).limit(1);
  if (!actor || actor.subtype !== 'human') {
    return Response.json({ error: 'Human owner countersign required', code: 'AGENT_APPROVAL_REQUIRED' }, { status: 403 });
  }
  const [member] = await db.select({ role: identityMembers.role }).from(identityMembers)
    .innerJoin(identities, eq(identities.id, identityMembers.identityDid)).where(and(
      eq(identityMembers.identityDid, ownerDid), eq(identityMembers.memberDid, caller.id),
      isNull(identityMembers.removedAt), inArray(identityMembers.role, ['owner', 'admin']),
      inArray(identities.scope, ['business', 'community', 'family']), isNull(identities.suspendedAt),
    )).limit(1);
  if (!member) return Response.json({ error: 'Current organization owner or admin required' }, { status: 403 });
  return caller;
}
