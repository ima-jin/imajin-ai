import { NextRequest, NextResponse } from 'next/server';
import { eq, and, sql, isNull, or } from 'drizzle-orm';
import { db, trustGraphInvites, profiles, podMembers } from '../../../src/db/index';
import { generateId } from '../../../src/lib/id';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;
const INVITE_COOLDOWN_DAYS = 7;
const INVITE_EXPIRY_DAYS = 7;

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
 * Check if user is in trust graph (member of at least one pod)
 */
async function isInTrustGraph(did: string): Promise<boolean> {
  const [membership] = await db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(
      eq(podMembers.did, did),
      isNull(podMembers.removedAt)
    ))
    .limit(1);

  return !!membership;
}

/**
 * POST /api/trust-invites - Create a new trust graph invite
 */
export async function POST(request: NextRequest) {
  const session = await getSession(request);

  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Require hard DID
  if (session.tier !== 'hard') {
    return NextResponse.json({
      error: 'Only users with verified identities (hard DID) can send invites'
    }, { status: 403 });
  }

  // Check if user is in trust graph
  const inTrustGraph = await isInTrustGraph(session.did);
  if (!inTrustGraph) {
    return NextResponse.json({
      error: 'You must be a member of the trust graph to send invites'
    }, { status: 403 });
  }

  // Get user's profile to check cooldown
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.did, session.did))
    .limit(1);

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }

  // Check cooldown
  const now = new Date();
  if (profile.nextInviteAvailableAt && profile.nextInviteAvailableAt > now) {
    const hoursRemaining = Math.ceil((profile.nextInviteAvailableAt.getTime() - now.getTime()) / (1000 * 60 * 60));
    return NextResponse.json({
      error: `Invite cooldown active. Next invite available in ${hoursRemaining} hours`,
      nextAvailableAt: profile.nextInviteAvailableAt.toISOString()
    }, { status: 429 });
  }

  // Check for pending invites from this user
  const [existingPending] = await db
    .select()
    .from(trustGraphInvites)
    .where(and(
      eq(trustGraphInvites.inviterDid, session.did),
      eq(trustGraphInvites.status, 'pending')
    ))
    .limit(1);

  if (existingPending) {
    return NextResponse.json({
      error: 'You already have a pending invite. Please wait for it to be accepted or revoke it first.',
      pendingInvite: existingPending
    }, { status: 429 });
  }

  // Parse request body
  const body = await request.json().catch(() => ({}));
  const { email, did: inviteeDid } = body;

  if (!email && !inviteeDid) {
    return NextResponse.json({
      error: 'Either email or did must be provided'
    }, { status: 400 });
  }

  // Create invite
  const inviteId = generateId('tginv_');
  const expiresAt = new Date(now.getTime() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const [invite] = await db.insert(trustGraphInvites).values({
    id: inviteId,
    inviterDid: session.did,
    inviteeEmail: email || null,
    inviteeDid: inviteeDid || null,
    status: 'pending',
    expiresAt,
  }).returning();

  return NextResponse.json({
    invite,
    message: 'Invite created successfully'
  }, { status: 201 });
}

/**
 * GET /api/trust-invites - List user's invites (sent and received)
 */
export async function GET(request: NextRequest) {
  const session = await getSession(request);

  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Get profile for email lookup
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.did, session.did))
    .limit(1);

  // Get sent invites
  const sentInvites = await db
    .select()
    .from(trustGraphInvites)
    .where(eq(trustGraphInvites.inviterDid, session.did));

  // Get received invites (by DID or email)
  const receivedInvites = await db
    .select()
    .from(trustGraphInvites)
    .where(
      or(
        eq(trustGraphInvites.inviteeDid, session.did),
        profile?.email ? eq(trustGraphInvites.inviteeEmail, profile.email) : sql`false`
      )
    );

  // Auto-expire old pending invites
  const now = new Date();
  const expiredIds = [...sentInvites, ...receivedInvites]
    .filter(inv => inv.status === 'pending' && inv.expiresAt < now)
    .map(inv => inv.id);

  if (expiredIds.length > 0) {
    await db
      .update(trustGraphInvites)
      .set({ status: 'expired' })
      .where(
        and(
          sql`${trustGraphInvites.id} = ANY(${expiredIds})`,
          eq(trustGraphInvites.status, 'pending')
        )
      );

    // Refresh data
    const [refreshedSent, refreshedReceived] = await Promise.all([
      db.select().from(trustGraphInvites).where(eq(trustGraphInvites.inviterDid, session.did)),
      db.select().from(trustGraphInvites).where(
        or(
          eq(trustGraphInvites.inviteeDid, session.did),
          profile?.email ? eq(trustGraphInvites.inviteeEmail, profile.email) : sql`false`
        )
      )
    ]);

    return NextResponse.json({
      sent: refreshedSent,
      received: refreshedReceived
    });
  }

  return NextResponse.json({
    sent: sentInvites,
    received: receivedInvites
  });
}
