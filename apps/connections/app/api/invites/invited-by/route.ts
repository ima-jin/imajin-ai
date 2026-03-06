import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNotNull } from 'drizzle-orm';
import { db, invites, trustGraphInvites, profiles } from '../../../../src/db/index';

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

  // Check code-based invites: consumedBy = current user
  const [codeInvite] = await db
    .select()
    .from(invites)
    .where(and(eq(invites.consumedBy, session.did), isNotNull(invites.consumedAt)))
    .limit(1);

  if (codeInvite) {
    return NextResponse.json({
      invitedBy: {
        did: codeInvite.fromDid,
        handle: codeInvite.fromHandle || null,
        name: null,
        avatar: null,
        date: codeInvite.consumedAt?.toISOString() || codeInvite.createdAt?.toISOString() || null,
      },
    });
  }

  // Check trust graph invites: inviteeDid = current user AND status = accepted
  const [tgInvite] = await db
    .select()
    .from(trustGraphInvites)
    .where(and(eq(trustGraphInvites.inviteeDid, session.did), eq(trustGraphInvites.status, 'accepted')))
    .limit(1);

  if (tgInvite) {
    const [inviterProfile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.did, tgInvite.inviterDid))
      .limit(1);

    return NextResponse.json({
      invitedBy: {
        did: tgInvite.inviterDid,
        handle: inviterProfile?.handle || null,
        name: inviterProfile?.displayName || null,
        avatar: inviterProfile?.avatar || null,
        date: tgInvite.acceptedAt?.toISOString() || tgInvite.createdAt?.toISOString() || null,
      },
    });
  }

  return NextResponse.json({ invitedBy: null });
}
