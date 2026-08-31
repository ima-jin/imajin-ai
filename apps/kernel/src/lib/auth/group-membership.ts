import { and, eq, isNull } from 'drizzle-orm';
import { db, identities, identityMembers } from '@/src/db';

/**
 * Read-side `identity_members` fallback for group/business-scope owners
 * (#1851, closes the read/write asymmetry left open by #1168).
 *
 * The delegated WRITE path (`resolveActingDid` + `X-Acting-For`) already
 * authorizes via an active `identity_members` row on the owner DID. The
 * private-asset READ check only ever compared `requesterDid === ownerDid`
 * — a group/business-scope owner's own members (not acting via delegation,
 * just authenticated as themselves) were denied.
 *
 * Scopes that represent a group/collective identity, as opposed to a
 * personal `actor` identity. Mirrors `VALID_SCOPES` in
 * app/auth/api/groups/route.ts.
 */
const GROUP_SCOPES = ['business', 'community', 'family'] as const;

/**
 * Does `requesterDid` hold an active `identity_members` row on `ownerDid`,
 * where `ownerDid` is itself a group/business-scope identity?
 *
 * v1 ruling (#1851 issue notes): any active membership row grants read —
 * no role floor yet. Deliberately gated to group-scope owners only: a
 * personal (`actor`) identity can also have `identity_members` rows (e.g.
 * the `role: 'agent'` X-Acting-For delegation bootstrap — see
 * `agent-authority.ts`), and that must never leak into that individual's
 * own private-asset reads by a non-owner. Returns `false` (deny) on any
 * lookup miss, including a missing owner row — fail-closed, same posture
 * as the rest of this seam.
 */
export async function isActiveGroupMember(ownerDid: string, requesterDid: string): Promise<boolean> {
  const [owner] = await db
    .select({ scope: identities.scope })
    .from(identities)
    .where(eq(identities.id, ownerDid))
    .limit(1);

  if (!owner || !(GROUP_SCOPES as readonly string[]).includes(owner.scope)) {
    return false;
  }

  const [membership] = await db
    .select({ memberDid: identityMembers.memberDid })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, ownerDid),
        eq(identityMembers.memberDid, requesterDid),
        isNull(identityMembers.removedAt),
      ),
    )
    .limit(1);

  return Boolean(membership);
}
