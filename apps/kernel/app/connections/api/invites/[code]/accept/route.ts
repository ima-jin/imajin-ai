import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db, invites, profiles, pods, podMembers, connections } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { publish } from '@imajin/bus';
import { checkPreliminaryEligibility, checkHardEligibility } from '@/src/lib/kernel/verification';
import { createLogger } from '@imajin/logger';

import { getSessionFromCookies } from '@/src/lib/kernel/session';

const log = createLogger('kernel');

const INVITE_COOLDOWN_DAYS = 7;

export async function POST(
  request: NextRequest,
  { params }: { params: { code: string } }
) {
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, params.code))
    .limit(1);

  if (!invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  if (invite.status !== 'pending') {
    return NextResponse.json({ error: `Invite is ${invite.status}` }, { status: 410 });
  }

  if (invite.usedCount >= invite.maxUses) {
    return NextResponse.json({ error: 'Invite already used' }, { status: 410 });
  }

  // Check expiry for email invites
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    await db
      .update(invites)
      .set({ status: 'expired' })
      .where(eq(invites.code, params.code));
    return NextResponse.json({ error: 'Invite has expired' }, { status: 410 });
  }

  if (invite.fromDid === session.did) {
    return NextResponse.json({ error: 'Cannot accept your own invite' }, { status: 400 });
  }

  // For email invites, verify this invite is for the current user
  if (invite.delivery === 'email') {
    const [inviteeProfile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.did, session.did))
      .limit(1);

    const isForUser = invite.toDid === session.did ||
      (invite.toEmail && inviteeProfile?.contactEmail === invite.toEmail);

    if (!isForUser) {
      return NextResponse.json({ error: 'This invite is not for you' }, { status: 403 });
    }
  }

  // Create a 2-person "connection" pod
  const podId = generateId('pod_');
  const senderLabel = invite.fromHandle || invite.fromDid.slice(0, 16);
  const accepterLabel = session.handle || session.did.slice(0, 16);

  await db.insert(pods).values({
    id: podId,
    name: `${senderLabel} ↔ ${accepterLabel}`,
    ownerDid: invite.fromDid,
    type: 'personal',
    visibility: 'private',
  });

  await db.insert(podMembers).values([
    { podId, did: invite.fromDid, role: 'member', addedBy: invite.fromDid },
    { podId, did: session.did, role: 'member', addedBy: session.did },
  ]);

  // Insert or reconnect — check for sybil prevention
  const [connDidA, connDidB] = [invite.fromDid, session.did].sort((a, b) => a.localeCompare(b));
  const [existingConn] = await db.select().from(connections)
    .where(and(eq(connections.didA, connDidA), eq(connections.didB, connDidB)))
    .limit(1);
  const isReconnect = !!existingConn;

  if (isReconnect) {
    await db.update(connections)
      .set({ disconnectedAt: null })
      .where(and(eq(connections.didA, connDidA), eq(connections.didB, connDidB)));
  } else {
    await db.insert(connections).values({ didA: connDidA, didB: connDidB });
  }

  const now = new Date();

  // Mark invite as accepted
  await db
    .update(invites)
    .set({
      status: 'accepted',
      acceptedAt: now.toISOString(),
      usedCount: sql`${invites.usedCount} + 1`,
      consumedBy: session.did,
      toDid: session.did,
    })
    .where(eq(invites.code, params.code));

  // For email invites, set cooldown on both inviter and invitee profiles
  if (invite.delivery === 'email') {
    const cooldownEnd = new Date(now.getTime() + INVITE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    await db
      .update(profiles)
      .set({ nextInviteAvailableAt: cooldownEnd })
      .where(eq(profiles.did, invite.fromDid));
    await db
      .update(profiles)
      .set({ nextInviteAvailableAt: cooldownEnd })
      .where(eq(profiles.did, session.did));
  }

  // Notify inviter — fire and forget
  (async () => {
    const [inviterProfile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.did, invite.fromDid))
      .limit(1);

    publish('connection.accepted', {
      issuer: session.did,
      subject: invite.fromDid,
      scope: 'connections',
      payload: {
        invite_code: invite.code,
        context_id: podId,
        context_type: 'connection',
        name: session.handle || session.did.slice(0, 16),
        email: inviterProfile?.contactEmail || undefined,
      },
    }).catch((err: unknown) => log.error({ err: String(err) }, 'Notify publish error'));
  })().catch((err: unknown) => log.error({ err: String(err) }, 'Notify setup error'));

  // Only emit attestations for NEW connections — prevents sybil farming via disconnect/reconnect
  if (!isReconnect) {
    publish('connection.accepted', {
      issuer: session.did,
      subject: invite.fromDid,
      scope: 'connections',
      payload: {
        invite_code: invite.code,
        context_id: podId,
        context_type: 'connection',
        name: session.handle || session.did.slice(0, 16),
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Attestation (connection.accepted) error');
    });

    publish('vouch', {
      issuer: invite.fromDid,
      subject: session.did,
      scope: 'connections',
      payload: {
        invite_code: invite.code,
        context_id: podId,
        context_type: 'connection',
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Attestation (vouch) error');
    });

    // Check verification eligibility for both parties — fire-and-forget
    checkPreliminaryEligibility(invite.fromDid)
      .catch((err: unknown) => log.error({ err: String(err) }, '[verification] preliminary check error (inviter)'));
    checkPreliminaryEligibility(session.did)
      .catch((err: unknown) => log.error({ err: String(err) }, '[verification] preliminary check error (accepter)'));
    checkHardEligibility(invite.fromDid)
      .catch((err: unknown) => log.error({ err: String(err) }, '[verification] hard check error (inviter)'));
    checkHardEligibility(session.did)
      .catch((err: unknown) => log.error({ err: String(err) }, '[verification] hard check error (accepter)'));
  }

  return NextResponse.json({
    ok: true,
    pod: { id: podId, name: `${senderLabel} ↔ ${accepterLabel}` },
  }, { status: 201 });
}
