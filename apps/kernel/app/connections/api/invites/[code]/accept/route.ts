import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db, invites, profiles, pods, podMembers, connections } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { emitAttestation } from '@imajin/auth';
import { notify } from '@imajin/notify';

import { getSessionFromCookies } from '@/src/lib/kernel/session';

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
  if (invite.expiresAt && invite.expiresAt < new Date()) {
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

  // Insert into first-class connections table
  const [connDidA, connDidB] = [invite.fromDid, session.did].sort((a, b) => a.localeCompare(b));
  await db.insert(connections).values({
    didA: connDidA,
    didB: connDidB,
  }).onConflictDoNothing();

  const now = new Date();

  // Mark invite as accepted
  await db
    .update(invites)
    .set({
      status: 'accepted',
      acceptedAt: now,
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

    notify.send({
      to: invite.fromDid,
      scope: "connection:invite-accepted",
      data: {
        ...(inviterProfile?.contactEmail && { email: inviterProfile.contactEmail }),
        name: session.handle || session.did.slice(0, 16),
      },
    }).catch((err: unknown) => console.error("Notify error:", err));

    // Record interest signals — connection.accepted → connections scope (both parties)
    notify.interest({ did: invite.fromDid, attestationType: 'connection.accepted' })
      .catch((err: unknown) => console.error("Interest signal error:", err));
    notify.interest({ did: session.did, attestationType: 'connection.accepted' })
      .catch((err: unknown) => console.error("Interest signal error:", err));
  })().catch((err: unknown) => console.error("Notify setup error:", err));

  emitAttestation({
    issuer_did: session.did,
    subject_did: invite.fromDid,
    type: 'connection.accepted',
    context_id: podId,
    context_type: 'connection',
    payload: { invite_id: invite.id },
  }).catch((err: unknown) => {
    console.error('Attestation (connection.accepted) error:', err);
  });

  emitAttestation({
    issuer_did: invite.fromDid,
    subject_did: session.did,
    type: 'vouch',
    context_id: podId,
    context_type: 'connection',
    payload: { invite_id: invite.id, delivery: invite.delivery },
  }).catch((err: unknown) => {
    console.error('Attestation (vouch) error:', err);
  });

  return NextResponse.json({
    ok: true,
    pod: { id: podId, name: `${senderLabel} ↔ ${accepterLabel}` },
  }, { status: 201 });
}
