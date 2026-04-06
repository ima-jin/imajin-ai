import { NextRequest, NextResponse } from 'next/server';
import { eq, and, or, isNotNull } from 'drizzle-orm';
import { db, invites, profiles } from '../../../../src/db/index';
import { getSessionFromCookies } from '@/src/lib/kernel/session';

/**
 * GET /api/invites/invited-by
 * Returns who invited the current user, or null if founding member.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Find invite where: consumedBy = current user (link invite accepted)
  // OR toDid = current user AND status = accepted (email invite accepted)
  const [foundInvite] = await db
    .select()
    .from(invites)
    .where(or(
      and(eq(invites.consumedBy, session.did), isNotNull(invites.consumedBy)),
      and(eq(invites.toDid, session.did), eq(invites.status, 'accepted')),
    ))
    .limit(1);

  if (!foundInvite) {
    return NextResponse.json({ invitedBy: null });
  }

  // Look up inviter profile for name/avatar
  const [inviterProfile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.did, foundInvite.fromDid))
    .limit(1);

  return NextResponse.json({
    invitedBy: {
      did: foundInvite.fromDid,
      handle: inviterProfile?.handle || foundInvite.fromHandle || null,
      name: inviterProfile?.displayName || null,
      avatar: inviterProfile?.avatar || null,
      date: foundInvite.acceptedAt?.toISOString() || foundInvite.createdAt?.toISOString() || null,
    },
  });
}
