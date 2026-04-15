import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { eq, desc, and, sql, isNull, count } from 'drizzle-orm';
import { db, invites, profiles, podMembers } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { sendEmail, trustGraphInviteEmail } from '@imajin/email';
import { emitAttestation, isVerifiedTier } from '@imajin/auth';
import { buildPublicUrl } from '@imajin/config';
import { createLogger } from '@imajin/logger';

import { getSessionFromCookies } from '@/src/lib/kernel/session';

const log = createLogger('kernel');

const INVITE_COOLDOWN_DAYS = 7;
const INVITE_EXPIRY_DAYS = 7;

/**
 * Tier-based invite limits.
 * Tier comes from the auth session identity tier.
 * Limit counts total pending invites (link or email).
 */
const INVITE_LIMITS: Record<string, number> = {
  soft: 0,
  preliminary: 5,
  established: 20,
  steward: 50,
  operator: Infinity,
};

function getInviteLimit(tier: string): number {
  return INVITE_LIMITS[tier] ?? INVITE_LIMITS.preliminary;
}

async function isInTrustGraph(did: string): Promise<boolean> {
  const [membership] = await db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(eq(podMembers.did, did), isNull(podMembers.removedAt)))
    .limit(1);
  return !!membership;
}

export async function POST(request: NextRequest) {
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const delivery: 'link' | 'email' = body.delivery === 'email' ? 'email' : 'link';

  if (delivery === 'email') {
    // Email invites require hard DID + trust graph membership
    if (!isVerifiedTier(session.tier)) {
      return NextResponse.json({
        error: 'Only users with verified identities can send email invites'
      }, { status: 403 });
    }

    const inTrustGraph = await isInTrustGraph(session.did);
    if (!inTrustGraph) {
      return NextResponse.json({
        error: 'You must be a member of the trust graph to send email invites'
      }, { status: 403 });
    }

    // Get profile for cooldown check and email sending
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.did, session.did))
      .limit(1);

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    const now = new Date();
    if (profile.nextInviteAvailableAt && profile.nextInviteAvailableAt > now) {
      const hoursRemaining = Math.ceil((profile.nextInviteAvailableAt.getTime() - now.getTime()) / (1000 * 60 * 60));
      return NextResponse.json({
        error: `Invite cooldown active. Next invite available in ${hoursRemaining} hours`,
        nextAvailableAt: profile.nextInviteAvailableAt.toISOString()
      }, { status: 429 });
    }

    // Check pending email invite count (tier-based limit)
    const emailLimit = getInviteLimit(session.tier);
    const pendingEmailCount = await db
      .select({ value: count() })
      .from(invites)
      .where(and(
        eq(invites.fromDid, session.did),
        eq(invites.delivery, 'email'),
        eq(invites.status, 'pending'),
      ));

    if (pendingEmailCount[0]?.value >= emailLimit) {
      return NextResponse.json({
        error: emailLimit === Infinity
          ? `You have too many pending email invites. Please wait for some to be accepted or revoke them first.`
          : `You have reached your email invite limit (${emailLimit}) for your tier. Please wait for some to be accepted or revoke them first.`,
      }, { status: 429 });
    }

    const { toEmail, note } = body;
    if (!toEmail) {
      return NextResponse.json({ error: 'toEmail is required for email invites' }, { status: 400 });
    }

    const code = randomBytes(12).toString('hex');
    const id = generateId('inv_');
    const expiresAtDate = new Date(now.getTime() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const [invite] = await db.insert(invites).values({
      id,
      code,
      fromDid: session.did,
      fromHandle: session.handle || null,
      toEmail: toEmail || null,
      note: note || null,
      delivery: 'email',
      status: 'pending',
      maxUses: 1,
      expiresAt: expiresAtDate.toISOString(),
    }).returning();

    const inviteUrl = `${buildPublicUrl('connections')}/invite/${session.did}/${code}`;
    const inviterName = profile.displayName || profile.handle || session.did;
    const inviterHandle = profile.handle || undefined;

    sendEmail({
      to: toEmail,
      subject: `${inviterName} invited you to Imajin`,
      html: trustGraphInviteEmail({
        inviterName,
        inviterHandle,
        inviteUrl,
        note: note || undefined,
        expiresAt: expiresAtDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      }),
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Failed to send invite email');
    });

    emitAttestation({
      issuer_did: session.did,
      subject_did: session.did,
      type: 'connection.invited',
      context_id: invite.id,
      context_type: 'connection',
      payload: { delivery: invite.delivery },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Attestation (connection.invited) error');
    });

    return NextResponse.json({ invite, url: inviteUrl }, { status: 201 });
  }

  // Link invite flow
  const limit = getInviteLimit(session.tier);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invites)
    .where(and(
      eq(invites.fromDid, session.did),
      eq(invites.delivery, 'link'),
      eq(invites.status, 'pending'),
    ));

  if (count >= limit) {
    return NextResponse.json({
      error: `Invite limit reached (${limit === Infinity ? 'unlimited' : limit}). ${limit < Infinity ? `Your tier allows ${limit} pending invite${limit === 1 ? '' : 's'}.` : ''}`,
      limit: limit === Infinity ? null : limit,
      pending: count,
    }, { status: 429 });
  }

  const code = randomBytes(12).toString('hex');
  const id = generateId('inv_');

  const [invite] = await db.insert(invites).values({
    id,
    code,
    fromDid: session.did,
    fromHandle: session.handle || null,
    toEmail: body.toEmail || null,
    note: body.note || null,
    delivery: 'link',
    status: 'pending',
    maxUses: body.maxUses || 1,
  }).returning();

  const inviteUrl = `${buildPublicUrl('connections')}/invite/${session.did}/${code}`;

  emitAttestation({
    issuer_did: session.did,
    subject_did: session.did,
    type: 'connection.invited',
    context_id: invite.id,
    context_type: 'connection',
    payload: { delivery: invite.delivery },
  }).catch((err: unknown) => {
    log.error({ err: String(err) }, 'Attestation (connection.invited) error');
  });

  return NextResponse.json({
    invite,
    url: inviteUrl,
    remaining: limit - count - 1,
  }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const limit = getInviteLimit(session.tier);

  const results = await db
    .select({
      invite: invites,
      acceptedHandle: profiles.handle,
      acceptedName: profiles.displayName,
    })
    .from(invites)
    .leftJoin(profiles, eq(invites.toDid, profiles.did))
    .where(eq(invites.fromDid, session.did))
    .orderBy(desc(invites.createdAt));

  // Quota is based on pending link invites only
  const pending = results.filter((r) => r.invite.delivery === 'link' && r.invite.status === 'pending').length;

  const now = Date.now();
  const withDaysAgo = results.map((r) => ({
    ...r.invite,
    acceptedBy: r.acceptedHandle || r.acceptedName || null,
    acceptedHandle: r.acceptedHandle || null,
    daysAgo: r.invite.createdAt ? Math.floor((now - new Date(r.invite.createdAt).getTime()) / 86400000) : 0,
    url: `${buildPublicUrl('connections')}/invite/${r.invite.fromDid}/${r.invite.code}`,
  }));

  return NextResponse.json({
    invites: withDaysAgo,
    tier: session.tier,
    limit: limit === Infinity ? null : limit,
    pending,
    remaining: limit === Infinity ? null : Math.max(0, limit - pending),
  });
}
