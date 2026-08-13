import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { eq, desc, and, sql, isNull, count } from 'drizzle-orm';
import { db, invites, profiles, podMembers, identities, attestations } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { sendEmail, trustGraphInviteEmail } from '@imajin/email';
import { isVerifiedTier, resolveEffectiveDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { buildPublicUrl } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { resolveOrMintInviteTarget, withNoDisclosure } from '@/src/lib/auth/claimable-stub';

import { getSessionFromCookies, getSessionForDid, type KernelSession } from '@/src/lib/kernel/session';

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

type InviteAuthResult = { session: KernelSession } | { error: string; status: number };

interface InviteContext {
  scopeDid: string | null;
  pendingAttestationId: string | null;
}

type InviteContextResult = { context: InviteContext } | { error: string; status: number };

/**
 * Validate the optional invite-context fields (#1834 Phase 2): `scopeDid`
 * (the org/community DID to land the claimer in) and `pendingAttestationId`
 * (the record awaiting the invitee's countersignature). Both are optional
 * and backward compatible — omitting them preserves today's create
 * behavior exactly.
 *
 * - `pendingAttestationId` must reference an existing, still-`pending`
 *   attestation that the inviter is a party to (issuer or subject) — an
 *   inviter cannot attach someone else's attestation to their invite.
 * - `scopeDid` must reference a real identity.
 */
async function validateInviteContext(
  session: KernelSession,
  body: Record<string, unknown>,
): Promise<InviteContextResult> {
  const scopeDid = typeof body.scopeDid === 'string' && body.scopeDid ? body.scopeDid : null;
  const pendingAttestationId =
    typeof body.pendingAttestationId === 'string' && body.pendingAttestationId ? body.pendingAttestationId : null;

  if (scopeDid) {
    const [scope] = await db
      .select({ id: identities.id })
      .from(identities)
      .where(eq(identities.id, scopeDid))
      .limit(1);
    if (!scope) {
      return { error: 'scopeDid does not reference a known identity', status: 400 };
    }
  }

  if (pendingAttestationId) {
    const [attestation] = await db
      .select({
        issuerDid: attestations.issuerDid,
        subjectDid: attestations.subjectDid,
        status: attestations.attestationStatus,
      })
      .from(attestations)
      .where(eq(attestations.id, pendingAttestationId))
      .limit(1);
    if (!attestation) {
      return { error: 'pendingAttestationId does not reference a known attestation', status: 400 };
    }
    if (attestation.status !== 'pending') {
      return { error: 'pendingAttestationId must reference a pending attestation', status: 400 };
    }
    if (attestation.issuerDid !== session.did && attestation.subjectDid !== session.did) {
      return {
        error: 'You must be a party to the attestation referenced by pendingAttestationId',
        status: 403,
      };
    }
  }

  return { context: { scopeDid, pendingAttestationId } };
}

/**
 * Dual guard (#1832): accept either an external app authenticated with the
 * `connections:write` scope, or a direct user session cookie — the same
 * `resolveEffectiveDid` shape already used by the countersign endpoint
 * (#1824/#1827) and the connections list/telemetry routes (#1812/#1814).
 *
 * This replaces the route-local `requireAppAuth` + manual cookie-fallback
 * plumbing added in #1793: `resolveEffectiveDid` tries an app token (or
 * legacy X-App-DID headers) first and falls back to session auth —
 * including a session JWT sent as `Authorization: Bearer` — internally, so
 * this route no longer has to special-case that itself.
 *
 * Once we have an effective DID (from either path), it's resolved to the
 * same `KernelSession` shape (tier, handle, role) so the rest of the
 * handler — tier limits, cooldowns, trust-graph checks — stays identical
 * regardless of which guard let the caller through.
 */
async function resolveInviteAuth(request: NextRequest): Promise<InviteAuthResult> {
  const auth = await resolveEffectiveDid(request, { scope: 'connections:write' });
  if (!auth.ok) {
    return { error: auth.error, status: auth.status };
  }

  const session = await getSessionForDid(auth.effectiveDid);
  if (!session) {
    return { error: 'Not authenticated', status: 401 };
  }
  return { session };
}

export async function POST(request: NextRequest) {
  const authResult = await resolveInviteAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { session } = authResult;

  const body = await request.json().catch(() => ({}));
  const delivery: 'link' | 'email' = body.delivery === 'email' ? 'email' : 'link';

  // Invite context extension (#1834 Phase 2): optional, backward compatible.
  const contextResult = await validateInviteContext(session, body);
  if ('error' in contextResult) {
    return NextResponse.json({ error: contextResult.error }, { status: contextResult.status });
  }
  const { scopeDid, pendingAttestationId } = contextResult.context;

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

    // Mint-on-new-email (#1834 Phase 1): resolve toEmail to a stable target
    // DID up front. A brand-new email mints a claimable stub; an email
    // already owned by a real identity, or a previously-minted stub, is
    // reused silently — the response shape below is identical either way,
    // so a second introducer of the same email learns nothing about whether
    // it already existed (match-without-disclosure).
    const toDid = await resolveOrMintInviteTarget(toEmail);

    const [invite] = await db.insert(invites).values({
      id,
      code,
      fromDid: session.did,
      fromHandle: session.handle || null,
      toEmail: toEmail || null,
      toDid,
      note: note || null,
      delivery: 'email',
      status: 'pending',
      maxUses: 1,
      expiresAt: expiresAtDate.toISOString(),
      scopeDid,
      pendingAttestationId,
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

    // subject = toDid (#1846): the invitee's DID, not the sender's. toDid is
    // already resolved above (real identity, or a freshly-minted claimable
    // stub) — using it here is what lets the attestation reactor land the
    // resulting auth.attestation's PendingSignature on the invitee, not the
    // sender.
    publish('connection.invited', {
      issuer: session.did,
      subject: toDid,
      scope: 'connections',
      payload: { context_id: invite.id, context_type: 'connection', delivery: invite.delivery },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Attestation (connection.invited) error');
    });

    // No-disclosure (#1839): the caller must never learn toDid pre-claim —
    // it's the resolved match target and doubles as an existence oracle for
    // the email (fresh mint vs. accrue-to-stub vs. resolve-to-real-identity).
    return NextResponse.json({ invite: withNoDisclosure(invite), url: inviteUrl }, { status: 201 });
  }

  // Link invite flow
  const limit = getInviteLimit(session.tier);

  const [{ count: pendingCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invites)
    .where(and(
      eq(invites.fromDid, session.did),
      eq(invites.delivery, 'link'),
      eq(invites.status, 'pending'),
    ));

  if (pendingCount >= limit) {
    const tierMessage = `Your tier allows ${limit} pending invite${limit === 1 ? '' : 's'}.`;
    return NextResponse.json({
      error: `Invite limit reached (${limit === Infinity ? 'unlimited' : limit}). ${limit < Infinity ? tierMessage : ''}`,
      limit: limit === Infinity ? null : limit,
      pending: pendingCount,
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
    scopeDid,
    pendingAttestationId,
  }).returning();

  const inviteUrl = `${buildPublicUrl('connections')}/invite/${session.did}/${code}`;

  // subject = session.did (#1846): for link invites the recipient is unknown
  // until the link is claimed, so there is no toDid to publish yet — the
  // link hasn't been claimed and no invitee identity exists. Publishing the
  // sender as subject keeps this event schema-valid without asserting an
  // invitee identity that doesn't exist yet.
  publish('connection.invited', {
    issuer: session.did,
    subject: session.did,
    scope: 'connections',
    payload: { context_id: invite.id, context_type: 'connection', delivery: invite.delivery },
  }).catch((err: unknown) => {
    log.error({ err: String(err) }, 'Attestation (connection.invited) error');
  });

  return NextResponse.json({
    invite: withNoDisclosure(invite),
    url: inviteUrl,
    remaining: limit - pendingCount - 1,
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
  const withDaysAgo = results.map((r) => {
    // No-disclosure (#1839): the joined profile (name/handle) and toDid are
    // legitimate bilateral knowledge only once the invite is accepted — a
    // pending row must never preview who (or whether anyone) toDid resolved
    // to, or the list becomes the same existence oracle invite-create closes.
    const disclosed = r.invite.status === 'accepted';
    return {
      ...withNoDisclosure(r.invite),
      acceptedBy: disclosed ? (r.acceptedHandle || r.acceptedName || null) : null,
      acceptedHandle: disclosed ? (r.acceptedHandle || null) : null,
      daysAgo: r.invite.createdAt ? Math.floor((now - new Date(r.invite.createdAt).getTime()) / 86400000) : 0,
      url: `${buildPublicUrl('connections')}/invite/${r.invite.fromDid}/${r.invite.code}`,
    };
  });

  return NextResponse.json({
    invites: withDaysAgo,
    tier: session.tier,
    limit: limit === Infinity ? null : limit,
    pending,
    remaining: limit === Infinity ? null : Math.max(0, limit - pending),
  });
}
