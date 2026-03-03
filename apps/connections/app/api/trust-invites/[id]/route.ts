import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, trustGraphInvites, profiles } from '../../../../src/db/index';

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
 * DELETE /api/trust-invites/:id - Revoke a pending invite
 */
export async function DELETE(
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

  // Only the inviter can revoke
  if (invite.inviterDid !== session.did) {
    return NextResponse.json({
      error: 'You can only revoke your own invites'
    }, { status: 403 });
  }

  // Can only revoke pending invites
  if (invite.status !== 'pending') {
    return NextResponse.json({
      error: `Cannot revoke ${invite.status} invite`
    }, { status: 400 });
  }

  // Mark as revoked
  await db
    .update(trustGraphInvites)
    .set({ status: 'revoked' })
    .where(eq(trustGraphInvites.id, params.id));

  // Free up the invite slot immediately (no cooldown on revoke)
  await db
    .update(profiles)
    .set({ nextInviteAvailableAt: null })
    .where(eq(profiles.did, session.did));

  return NextResponse.json({
    success: true,
    message: 'Invite revoked successfully. You can send a new invite immediately.'
  }, { status: 200 });
}
