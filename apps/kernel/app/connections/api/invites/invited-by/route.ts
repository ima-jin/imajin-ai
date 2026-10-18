import { NextRequest, NextResponse } from 'next/server';
import { eq, and, or, isNotNull } from 'drizzle-orm';
import { db, invites, profiles } from '@/src/db';
import { resolveEffectiveDid } from '@imajin/auth';

/**
 * GET /api/invites/invited-by
 * Returns who invited the current user, or null if founding member.
 */
export async function GET(request: NextRequest) {
  const auth = await resolveEffectiveDid(request, { scope: 'connections:read' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Find invite where: consumedBy = current user (link invite accepted)
  // OR toDid = current user AND status = accepted (email invite accepted)
  const [foundInvite] = await db
    .select()
    .from(invites)
    .where(or(
      and(eq(invites.consumedBy, auth.effectiveDid), isNotNull(invites.consumedBy)),
      and(eq(invites.toDid, auth.effectiveDid), eq(invites.status, 'accepted')),
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
      date: foundInvite.acceptedAt || foundInvite.createdAt || null,
    },
  });
}
