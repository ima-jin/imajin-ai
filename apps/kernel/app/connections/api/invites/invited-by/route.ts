import { NextRequest, NextResponse } from 'next/server';
import { eq, and, or, isNotNull } from 'drizzle-orm';
import { db, invites, profiles } from '../../../../src/db/index';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

async function getSession(request: NextRequest) {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: request.headers.get('cookie') || '' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * GET /api/invites/invited-by
 * Returns who invited the current user, or null if founding member.
 */
export async function GET(request: NextRequest) {
  const session = await getSession(request);
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
