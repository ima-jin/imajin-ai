import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db, invites, profiles, pods, podMembers, connections } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { publish } from '@imajin/bus';
import { checkPreliminaryEligibility, checkHardEligibility } from '@/src/lib/kernel/verification';
import { createLogger } from '@imajin/logger';
import { isUnclaimedStub, tryActivateClaim } from '@/src/lib/auth/claimable-stub';
import { resolveDidForEmail } from '@imajin/auth';

import { getSessionFromCookies } from '@/src/lib/kernel/session';

const log = createLogger('kernel');

const INVITE_COOLDOWN_DAYS = 7;

type Invite = typeof invites.$inferSelect;
type AccepterResult = { did: string; handle?: string } | { error: string; status: number };

/**
 * Resolve who is accepting this invite.
 *
 * The common case is a normal session cookie. The other case (#1834 Phase
 * 1) is a brand-new person clicking an email invite whose target was
 * pre-minted as a claimable stub at invite-create time (mint-on-new-email):
 * they have no session yet, so the click itself accepts AS that stub DID.
 * This is the "link-click alone" path from the ratified design — it forms
 * the connection immediately (crediting MJN to the inviter, which serves as
 * that inviter's countersign) but leaves the identity unverified until the
 * claimant separately proves email ownership (`verifyClaimantEmail`, which
 * calls `tryActivateClaim`).
 *
 * Only DIDs we minted as claimable stubs (`isUnclaimedStub`) are reachable
 * this way — an arbitrary soft DID from a different mint site can never be
 * "accepted into" by an anonymous click.
 */
async function resolveAccepter(request: NextRequest, invite: Invite): Promise<AccepterResult> {
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (session?.did) {
    return { did: session.did, handle: session.handle };
  }

  if (invite.delivery === 'email' && invite.toDid && await isUnclaimedStub(invite.toDid)) {
    return { did: invite.toDid };
  }

  return { error: 'Not authenticated', status: 401 };
}

export async function POST(request: NextRequest, props: { params: Promise<{ code: string }> }) {
  const params = await props.params;

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

  const accepterResult = await resolveAccepter(request, invite);
  if ('error' in accepterResult) {
    return NextResponse.json({ error: accepterResult.error }, { status: accepterResult.status });
  }
  const { did: accepterDid, handle: accepterHandle } = accepterResult;

  if (invite.fromDid === accepterDid) {
    return NextResponse.json({ error: 'Cannot accept your own invite' }, { status: 400 });
  }

  // For email invites, verify this invite is for the current user. The
  // fallback resolves invite.toEmail through the SAME identity-resolution
  // seam invite-create uses (#1858 / #1834 structural review) instead of a
  // raw, non-normalized profiles.contactEmail === invite.toEmail
  // comparison — so create and accept agree on identity by construction.
  // This is what lets a keypair-registered user whose email lives only in
  // profiles.contactEmail (no auth.credentials row) still accept an invite
  // that was minted against a mismatched stub DID at create time.
  if (invite.delivery === 'email') {
    const isForUser = invite.toDid === accepterDid ||
      (!!invite.toEmail && (await resolveDidForEmail(invite.toEmail)) === accepterDid);

    if (!isForUser) {
      return NextResponse.json({ error: 'This invite is not for you' }, { status: 403 });
    }
  }

  // Create a 2-person "connection" pod
  const podId = generateId('pod_');
  const senderLabel = invite.fromHandle || invite.fromDid.slice(0, 16);
  const accepterLabel = accepterHandle || accepterDid.slice(0, 16);

  await db.insert(pods).values({
    id: podId,
    name: `${senderLabel} ↔ ${accepterLabel}`,
    ownerDid: invite.fromDid,
    type: 'personal',
    visibility: 'private',
  });

  await db.insert(podMembers).values([
    { podId, did: invite.fromDid, role: 'member', addedBy: invite.fromDid },
    { podId, did: accepterDid, role: 'member', addedBy: accepterDid },
  ]);

  // Insert or reconnect — check for sybil prevention
  const [connDidA, connDidB] = [invite.fromDid, accepterDid].sort((a, b) => a.localeCompare(b));
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
      consumedBy: accepterDid,
      toDid: accepterDid,
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
      .where(eq(profiles.did, accepterDid));

    // Bilateral claim ratchet (#1834): this accept IS the inviter-side
    // countersign. If the claimant already verified their email before
    // clicking, this closes the ratchet right now; otherwise it's a no-op
    // until verifyClaimantEmail runs later.
    await tryActivateClaim(accepterDid).catch((err: unknown) => {
      log.error({ err: String(err), did: accepterDid }, '[claimable-stub] claim activation error on accept');
    });
  }

  // Notify inviter — fire and forget
  (async () => {
    const [inviterProfile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.did, invite.fromDid))
      .limit(1);

    publish('connection.accepted', {
      issuer: accepterDid,
      subject: invite.fromDid,
      scope: 'connections',
      payload: {
        invite_code: invite.code,
        context_id: podId,
        context_type: 'connection',
        name: accepterHandle || accepterDid.slice(0, 16),
        email: inviterProfile?.contactEmail || undefined,
      },
    }).catch((err: unknown) => log.error({ err: String(err) }, 'Notify publish error'));
  })().catch((err: unknown) => log.error({ err: String(err) }, 'Notify setup error'));

  // Only emit attestations for NEW connections — prevents sybil farming via disconnect/reconnect
  if (!isReconnect) {
    publish('connection.accepted', {
      issuer: accepterDid,
      subject: invite.fromDid,
      scope: 'connections',
      payload: {
        invite_code: invite.code,
        context_id: podId,
        context_type: 'connection',
        name: accepterHandle || accepterDid.slice(0, 16),
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Attestation (connection.accepted) error');
    });

    publish('vouch', {
      issuer: invite.fromDid,
      subject: accepterDid,
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
    checkPreliminaryEligibility(accepterDid)
      .catch((err: unknown) => log.error({ err: String(err) }, '[verification] preliminary check error (accepter)'));
    checkHardEligibility(invite.fromDid)
      .catch((err: unknown) => log.error({ err: String(err) }, '[verification] hard check error (inviter)'));
    checkHardEligibility(accepterDid)
      .catch((err: unknown) => log.error({ err: String(err) }, '[verification] hard check error (accepter)'));
  }

  return NextResponse.json({
    ok: true,
    pod: { id: podId, name: `${senderLabel} ↔ ${accepterLabel}` },
  }, { status: 201 });
}
