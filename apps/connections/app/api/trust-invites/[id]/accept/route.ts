import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db, trustGraphInvites, profiles, pods, podMembers } from '../../../../../src/db/index';
import { generateId } from '../../../../../src/lib/id';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;
const INVITE_COOLDOWN_DAYS = 7;

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
 * POST /api/trust-invites/:id/accept - Accept a trust graph invite
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession(request);

  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Get the invite
  const [invite] = await db
    .select()
    .from(trustGraphInvites)
    .where(eq(trustGraphInvites.id, params.id))
    .limit(1);

  if (!invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  // Verify invite status
  if (invite.status !== 'pending') {
    return NextResponse.json({
      error: `Invite is ${invite.status}`,
      status: invite.status
    }, { status: 410 });
  }

  // Check expiry
  if (invite.expiresAt < new Date()) {
    await db
      .update(trustGraphInvites)
      .set({ status: 'expired' })
      .where(eq(trustGraphInvites.id, params.id));

    return NextResponse.json({
      error: 'Invite has expired'
    }, { status: 410 });
  }

  // Get invitee profile
  const [inviteeProfile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.did, session.did))
    .limit(1);

  // Verify this invite is for the current user
  const isForUser = invite.inviteeDid === session.did ||
    (invite.inviteeEmail && inviteeProfile?.email === invite.inviteeEmail);

  if (!isForUser) {
    return NextResponse.json({
      error: 'This invite is not for you'
    }, { status: 403 });
  }

  // Prevent self-acceptance
  if (invite.inviterDid === session.did) {
    return NextResponse.json({
      error: 'Cannot accept your own invite'
    }, { status: 400 });
  }

  // Get inviter profile for pod naming
  const [inviterProfile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.did, invite.inviterDid))
    .limit(1);

  // Create bilateral connection pod
  const podId = generateId('pod_');
  const inviterLabel = inviterProfile?.handle || inviterProfile?.displayName || invite.inviterDid.slice(0, 16);
  const inviteeLabel = inviteeProfile?.handle || inviteeProfile?.displayName || session.did.slice(0, 16);

  await db.insert(pods).values({
    id: podId,
    name: `${inviterLabel} ↔ ${inviteeLabel}`,
    ownerDid: invite.inviterDid,
    type: 'personal',
    visibility: 'private',
  });

  // Add both users as members
  await db.insert(podMembers).values([
    { podId, did: invite.inviterDid, role: 'member', addedBy: invite.inviterDid },
    { podId, did: session.did, role: 'member', addedBy: session.did },
  ]);

  // Mark invite as accepted
  const now = new Date();
  await db
    .update(trustGraphInvites)
    .set({
      status: 'accepted',
      acceptedAt: now,
      inviteeDid: session.did, // Update if it was only by email
    })
    .where(eq(trustGraphInvites.id, params.id));

  // Set cooldown for inviter
  const cooldownEnd = new Date(now.getTime() + INVITE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  await db
    .update(profiles)
    .set({ nextInviteAvailableAt: cooldownEnd })
    .where(eq(profiles.did, invite.inviterDid));

  // Give invitee their own invite slot with cooldown
  await db
    .update(profiles)
    .set({ nextInviteAvailableAt: cooldownEnd })
    .where(eq(profiles.did, session.did));

  return NextResponse.json({
    success: true,
    pod: {
      id: podId,
      name: `${inviterLabel} ↔ ${inviteeLabel}`,
    },
    message: 'Invite accepted successfully. You are now connected!'
  }, { status: 200 });
}
