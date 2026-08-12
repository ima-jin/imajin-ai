export const dynamic = "force-dynamic";
/**
 * GET /api/onboard/verify?token=xxx
 *
 * Complete email verification: mint soft DID, set session cookie, redirect.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, onboardTokens } from '@/src/db';
import { createSessionToken, getSessionCookieOptions, verifySessionToken } from '@/src/lib/auth/jwt';
import { emitSessionAttestation } from '@/src/lib/auth/emit-session-attestation';
import { publish } from '@imajin/bus';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createLogger } from '@imajin/logger';
import { rateLimit, getClientIP } from '@imajin/config';
import { consumePendingInvites } from '@/src/lib/auth/consume-invite';
import {
  addScopeMembership,
  handleExpiredOrUsedToken,
  resolveOnboardIdentity,
  resolveOnboardRedirect,
} from '@/src/lib/auth/onboard';

const log = createLogger('kernel');

export async function GET(request: NextRequest) {
  try {
    // Generous rate limit — token TTL + single-use enforces correctness.
    // A user clicking once should never hit this.
    const ip = getClientIP(request);
    const rl = rateLimit(ip, 60, 60_000);
    if (rl.limited) {
      return errorPage(
        'Too Many Requests',
        'You\'ve made too many requests. Please wait a moment and try again.',
        429
      );
    }

    const token = request.nextUrl.searchParams.get('token');

    if (!token) {
      return errorPage('Invalid Link', 'This link is missing a verification token.');
    }

    // Check if user already has a valid session — if so, skip token validation
    // and just redirect. Handles double-clicks, email prefetchers, and re-visits.
    const cookieConfig = getSessionCookieOptions();
    const existingCookie = request.cookies.get(cookieConfig.name)?.value;
    let existingSession: Awaited<ReturnType<typeof verifySessionToken>> | null = null;
    if (existingCookie) {
      existingSession = await verifySessionToken(existingCookie).catch(() => null);
    }

    // Look up token
    const [record] = await db
      .select()
      .from(onboardTokens)
      .where(
        and(
          eq(onboardTokens.token, token),
          gt(onboardTokens.expiresAt, new Date()),
          isNull(onboardTokens.usedAt),
        )
      )
      .limit(1);

    if (!record) {
      const DEFAULT_REDIRECT = 'https://events.imajin.ai';
      const graceResponse = await handleExpiredOrUsedToken(
        token, existingSession, getSessionCookieOptions(), DEFAULT_REDIRECT,
      );
      if (graceResponse) return graceResponse;

      // Check if it was a used token (not just missing) to give a better error
      const [usedRecord] = await db
        .select({ usedAt: onboardTokens.usedAt, redirectUrl: onboardTokens.redirectUrl })
        .from(onboardTokens)
        .where(eq(onboardTokens.token, token))
        .limit(1);

      if (usedRecord?.usedAt) {
        const redirectUrl = usedRecord.redirectUrl ?? DEFAULT_REDIRECT;
        return errorPage(
          'Already Verified',
          `This link was already used. You're probably already logged in — <a href="${redirectUrl}" style="color:#60a5fa;text-decoration:underline;">click here to continue</a>.<br><br>If that doesn't work, your browser may be blocking cookies. Try disabling your ad blocker or using a different browser, then request a new link.`,
        );
      }

      return errorPage('Link Expired', 'This verification link has expired. Please go back and request a new one.', 410);
    }

    // Mark token as used
    await db
      .update(onboardTokens)
      .set({ usedAt: new Date() })
      .where(eq(onboardTokens.id, record.id));

    // Resolve the DID + identity for this email (#1834 Phase 2): reuses an
    // existing claimable stub's DID — running the claimant-verification
    // half of the Phase-1 ratchet — when this email was previously
    // introduced via a scoped invite, otherwise falls back to the
    // pre-existing soft-DID mint path unchanged.
    const normalizedEmail = record.email.toLowerCase().trim();
    const { did, identity, created, claimActivated } = await resolveOnboardIdentity(normalizedEmail, record.name);

    // Emit identity.created for newly minted DIDs (triggers token emission)
    if (created) {
      publish('identity.created', {
        issuer: did, subject: did, scope: 'auth',
        payload: { did, scope: 'actor', subtype: 'human', tier: 'soft',
                   context_id: did, context_type: 'identity' },
      }).catch((err) => log.error({ err: String(err) }, '[onboard/verify] identity.created error (non-fatal)'));
    }

    // Auto-consume any pending invites sent to this email — fire and forget
    consumePendingInvites({
      did,
      email: record.email,
      handle: identity.handle,
    }).catch(() => {});

    // Create session token — use actual tier (supports hard DID re-auth via magic link)
    const identityTier = (identity.tier || 'soft') as 'soft' | 'preliminary' | 'established';

    // Side effects shared by both branches (polling + non-polling):
    // forest membership, scope attestation, session attestation, ticket migration.
    // None of these depend on whether we set a cookie or hand off via token.
    if (record.scopeDid) {
      const scopeDid = record.scopeDid;
      await addScopeMembership(scopeDid, did);
      publish('scope.onboard', {
        issuer: scopeDid, subject: did, scope: 'auth',
        payload: { context_id: scopeDid, context_type: 'forest' },
      }).catch(err => log.error({ err: String(err) }, '[onboard/verify] Scope attestation failed (non-fatal)'));
    }

    emitSessionAttestation({
      did,
      method: "email_onboard",
      tier: identityTier,
      userAgent: request.headers.get("user-agent"),
    }).catch(err => log.error({ err: String(err) }, 'Session attestation error'));

    // Fire-and-forget: migrate any guest tickets purchased with this email to the hard DID
    const EVENTS_URL = process.env.EVENTS_SERVICE_URL || 'http://localhost:7006';
    fetch(`${EVENTS_URL}/events/api/migrate-tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normalizedEmail, hardDid: did }),
    }).catch(err => log.warn({ err: String(err) }, 'Ticket migration call failed (non-fatal)'));

    // Branch on response shape only:
    // - Polling: store handoff token, render affirmation (no cookie, no redirect).
    // - Non-polling: mint session, set cookie, redirect (preserves legacy behavior).
    if (record.pollHandle) {
      const handoffToken = nanoid(32);
      await db
        .update(onboardTokens)
        .set({ handoffToken })
        .where(eq(onboardTokens.id, record.id));
      return affirmationPage();
    }

    const sessionToken = await createSessionToken({
      sub: did,
      scope: 'actor',
      subtype: 'human',
      tier: identityTier,
      handle: identity.handle || undefined,
      name: identity.name || undefined,
    });

    const cookieOptions = getSessionCookieOptions();
    // Post-claim routing (#1834 Phase 2): when this verification closed the
    // ratchet for an invite carrying a pending attestation, land the
    // claimant on the record waiting for their countersignature instead of
    // the invite's default redirect. Landing here is navigation only — it
    // never activates or signs anything, and an unverified click alone
    // (claimActivated: false) can never reach this branch.
    const redirectUrl = await resolveOnboardRedirect({
      inviteCode: record.inviteCode,
      claimActivated,
      defaultRedirectUrl: record.redirectUrl || '/',
    });
    const response = NextResponse.redirect(redirectUrl);
    response.cookies.set(cookieOptions.name, sessionToken, cookieOptions.options);
    if (record.scopeDid) {
      response.cookies.set('x-acting-as', record.scopeDid, { path: '/', maxAge: 31536000, sameSite: 'lax' });
    }
    return response;

  } catch (error) {
    log.error({ err: String(error) }, 'Onboard verify error');
    return errorPage('Verification Error', 'Something went wrong verifying your email. Please try again.');
  }
}

function errorPage(title: string, message: string, status = 400): NextResponse {
  return new NextResponse(
    `<!DOCTYPE html>
<html>
<head><title>${title}</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui;max-width:500px;margin:80px auto;padding:20px;text-align:center;background:#000;color:#e4e4e7;}h1{color:#ef4444;font-size:24px;}p{color:#a1a1aa;line-height:1.6;}</style>
</head>
<body><h1>${title}</h1><p>${message}</p></body>
</html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function affirmationPage(): NextResponse {
  return new NextResponse(
    `<!DOCTYPE html>
<html>
<head><title>Email Verified</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui;max-width:500px;margin:80px auto;padding:20px;text-align:center;background:#000;color:#e4e4e7;}h1{color:#22c55e;font-size:24px;}p{color:#a1a1aa;line-height:1.6;}</style>
</head>
<body><h1>✅ Email Verified</h1><p>You can close this tab and return to where you started.</p></body>
</html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
