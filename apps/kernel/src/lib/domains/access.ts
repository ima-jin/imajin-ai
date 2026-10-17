import { requireAuth, type Identity } from '@imajin/auth';
import { enforceDelegationPolicy, type MutationClass } from '@imajin/auth/delegation-policy';
import { and, eq, isNull } from 'drizzle-orm';
import { db, identities, identityMembers } from '@/src/db';

/** Resolve actual authority, never the role supplied by an acting-as overlay. */
export async function canManageIdentityDomains(did: string, callerDid: string): Promise<boolean> {
  const [target] = await db.select({ scope: identities.scope, subtype: identities.subtype })
    .from(identities)
    .where(and(eq(identities.id, did), isNull(identities.suspendedAt)))
    .limit(1);
  if (!target || target.subtype === 'agent') return false;
  if (target.scope === 'actor') return callerDid === did;

  const [member] = await db.select({ role: identityMembers.role })
    .from(identityMembers)
    .where(and(
      eq(identityMembers.identityDid, did),
      eq(identityMembers.memberDid, callerDid),
      isNull(identityMembers.removedAt),
    ))
    .limit(1);
  return member?.role === 'owner' || member?.role === 'admin';
}

export async function requireDomainManager(
  request: Request,
  did: string,
  mutation?: { action: string; class: MutationClass },
): Promise<Identity | Response> {
  const auth = await requireAuth(request, { service: 'auth' });
  if ('error' in auth) return Response.json({ error: auth.error }, { status: auth.status });
  const caller = auth.identity;
  if (mutation) {
    const denied = enforceDelegationPolicy(caller, { ...mutation, resourceId: did });
    if (denied) return denied;
  }
  // Overlays select a target; they cannot replace the authenticated member DID.
  const selectedDid = caller.actingFor ?? caller.actingAs;
  if (selectedDid && selectedDid !== did) {
    return Response.json({ error: 'Identity context does not match the requested owner' }, { status: 403 });
  }
  const [actor] = await db.select({ subtype: identities.subtype })
    .from(identities)
    .where(and(eq(identities.id, caller.id), isNull(identities.suspendedAt)))
    .limit(1);
  if (!actor || actor.subtype === 'agent' || !await canManageIdentityDomains(did, caller.id)) {
    return Response.json({ error: 'Active identity owner or admin required' }, { status: 403 });
  }
  return caller;
}
