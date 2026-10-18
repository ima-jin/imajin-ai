/**
 * POST /api/onboard
 *
 * Initiate email verification for anonymous → soft DID onboarding.
 * Sends a verification email with a magic link.
 *
 * Body: { email, name?, redirectUrl?, context? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, credentials, identities, invites } from '@/src/db';
import { deliverOnboardEmail } from '@/src/lib/auth/onboard-delivery';
import { mailDeliveryFailure } from '@/src/lib/kernel/mail-delivery-error';
import { getClient } from '@imajin/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders, rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { publicOrigin } from '@/src/lib/http/public-origin';

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  // IP-level guard: 20 req/min. Two paths funnel through here (#912):
  //   - new soft-DID onboarding (purchase / signup)
  //   - existing-account login (mode='login', replaces /api/magic/send)
  const ip = getClientIP(request);
  const ipRl = rateLimit(ip, 20, 60_000);
  if (ipRl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: ipRl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(ipRl.retryAfter) } }
    );
  }

  try {
    const body = await request.json();
    const { email, name, redirectUrl, context, scopeDid, wantPolling, mode, inviteCode } = body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Valid email required' },
        { status: 400, headers: cors }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Email-level guard: 3 verification emails per email address per hour.
    // Applied before any DB lookups so enumeration protection still holds
    // (unknown emails silently succeed in login mode but still consume a slot).
    const emailRl = rateLimit(`onboard-email:${normalizedEmail}`, 3, 3_600_000);
    if (emailRl.limited) {
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: emailRl.retryAfter },
        { status: 429, headers: { ...cors, 'Retry-After': String(emailRl.retryAfter) } }
      );
    }

    if (mode === 'login') {
      // Only send to existing soft-DID accounts; reject hard DIDs; enumerate-protect.
      const loginCheck = await resolveLoginEmail(normalizedEmail);
      if (loginCheck.notFound) {
        log.info({ email: normalizedEmail }, 'Login requested for unknown email');
        return NextResponse.json({ sent: true }, { headers: cors });
      }
      if (loginCheck.hardDid) {
        return NextResponse.json(
          { error: 'This account requires private key authentication. Use your backup key file to log in.' },
          { status: 403, headers: cors },
        );
      }
    }

    // Invite context extension (#1834 Phase 2): re-resolve scopeDid from
    // the invite row itself when an inviteCode is supplied, rather than
    // trusting a client-supplied scopeDid outright — context stays
    // server-side. An unknown/invalid code is ignored rather than blocking
    // onboarding (the person can still complete plain email verification).
    const { resolvedScopeDid, resolvedInviteCode } = await resolveInviteContext(inviteCode, scopeDid);

    const result = await deliverOnboardEmail({
      email: normalizedEmail,
      name: name?.trim() || null,
      redirectUrl: redirectUrl || null,
      context: context || null,
      scopeDid: resolvedScopeDid,
      inviteCode: resolvedInviteCode,
      wantPolling: wantPolling === true,
      authUrl: `${publicOrigin(request)}/auth`,
    });

    if (!result.success) {
      log.error({}, 'Failed to send onboard email');
      return NextResponse.json(
        mailDeliveryFailure(result.error, 'Failed to send verification email'),
        { status: 502, headers: cors }
      );
    }

    return NextResponse.json(
      { sent: true, ...(result.pollHandle ? { pollHandle: result.pollHandle } : {}) },
      { headers: cors }
    );

  } catch {
    log.error({}, 'Onboard start error');
    return NextResponse.json(
      { error: 'Failed to initiate onboarding' },
      { status: 500, headers: cors }
    );
  }
});

/**
 * Re-resolve invite context (#1834 Phase 2) from the invite row by code,
 * rather than trusting a client-supplied `scopeDid` outright. Returns the
 * original `scopeDid` unchanged when there is no (valid) `inviteCode` —
 * an unknown/invalid code is ignored rather than blocking onboarding.
 */
async function resolveInviteContext(
  inviteCode: unknown,
  scopeDid: unknown,
): Promise<{ resolvedScopeDid: string | null; resolvedInviteCode: string | null }> {
  const fallbackScopeDid = typeof scopeDid === 'string' && scopeDid ? scopeDid : null;
  if (!inviteCode || typeof inviteCode !== 'string') {
    return { resolvedScopeDid: fallbackScopeDid, resolvedInviteCode: null };
  }

  const [invite] = await db
    .select({ code: invites.code, scopeDid: invites.scopeDid })
    .from(invites)
    .where(eq(invites.code, inviteCode))
    .limit(1);

  if (!invite) {
    return { resolvedScopeDid: fallbackScopeDid, resolvedInviteCode: null };
  }

  return { resolvedScopeDid: invite.scopeDid || fallbackScopeDid, resolvedInviteCode: invite.code };
}

/** Returns { notFound } when the email has no account, { hardDid } when it does but isn't a soft DID. */
async function resolveLoginEmail(
  normalizedEmail: string,
): Promise<{ notFound: true } | { notFound: false; hardDid: boolean }> {
  const [cred] = await db
    .select({ did: credentials.did })
    .from(credentials)
    .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalizedEmail)))
    .limit(1);

  let resolvedDid = cred?.did;

  if (!resolvedDid) {
    const rawSql = getClient();
    const profileRows = await rawSql<{ did: string }[]>`
      SELECT did FROM profile.profiles
      WHERE LOWER(contact_email) = ${normalizedEmail}
      LIMIT 1
    `;
    if (profileRows.length > 0) {
      resolvedDid = profileRows[0].did;
      // Intentionally NOT inserting a credential here — profile.contact_email
      // is a lookup hint, not proof of ownership. Verified credentials are
      // only created by the magic-link verify step (see createOrFindSoftDid).
    }
  }

  if (!resolvedDid) return { notFound: true };

  const [identity] = await db
    .select({ tier: identities.tier })
    .from(identities)
    .where(eq(identities.id, resolvedDid))
    .limit(1);

  return { notFound: false, hardDid: !!(identity && identity.tier !== 'soft') };
}


export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
