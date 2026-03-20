/**
 * GET /api/onboard/verify?token=xxx
 *
 * Complete email verification: mint soft DID, set session cookie, redirect.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { onboardTokens, identities, credentials } from '@/src/db/schema';
import { createSessionToken, getSessionCookieOptions, verifySessionToken } from '@/lib/jwt';
import { emitSessionAttestation } from '@/lib/emit-session-attestation';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export async function GET(request: NextRequest) {
  try {
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
      // Token is used or expired — but if user already has a session, just redirect
      if (existingSession) {
        const [anyRecord] = await db
          .select()
          .from(onboardTokens)
          .where(eq(onboardTokens.token, token))
          .limit(1);
        const redirectUrl = anyRecord?.redirectUrl || 'https://events.imajin.ai';
        return NextResponse.redirect(redirectUrl);
      }

      // Check if token exists but was already used (vs truly expired/invalid)
      const [usedRecord] = await db
        .select()
        .from(onboardTokens)
        .where(eq(onboardTokens.token, token))
        .limit(1);

      if (usedRecord?.usedAt) {
        // Grace window: if token was used within the last 60 seconds, re-issue session.
        // Handles email security scanners (Outlook Safe Links, Proofpoint, etc.)
        // that consume the token via GET before the user clicks.
        const usedAgo = Date.now() - new Date(usedRecord.usedAt).getTime();
        const GRACE_MS = 60_000;

        if (usedAgo < GRACE_MS) {
          // Re-issue session — the token already proved email ownership.
          // Look up the stable DID via the credentials table.
          const normalizedEmail = usedRecord.email.toLowerCase().trim();
          const [existingCred] = await db
            .select({ did: credentials.did })
            .from(credentials)
            .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalizedEmail)))
            .limit(1);

          if (existingCred?.did) {
            const [identity] = await db
              .select()
              .from(identities)
              .where(eq(identities.id, existingCred.did))
              .limit(1);

            if (identity) {
              const sessionToken = await createSessionToken({
                sub: existingCred.did,
                type: 'human',
                tier: 'soft',
                handle: identity.handle || undefined,
                name: identity.name || undefined,
              });

              const cookieOptions = getSessionCookieOptions();
              const redirectUrl = usedRecord.redirectUrl || 'https://events.imajin.ai';
              const response = NextResponse.redirect(redirectUrl);
              response.cookies.set(cookieOptions.name, sessionToken, cookieOptions.options);
              return response;
            }
          }
        }

        const redirectUrl = usedRecord.redirectUrl || 'https://events.imajin.ai';
        return errorPage(
          'Already Verified',
          `This link was already used. You're probably already logged in — <a href="${redirectUrl}" style="color:#60a5fa;text-decoration:underline;">click here to continue</a>.<br><br>If that doesn't work, your browser may be blocking cookies. Try disabling your ad blocker or using a different browser, then request a new link.`
        );
      }

      return errorPage('Link Expired', 'This verification link has expired. Please go back and request a new one.');
    }

    // Mark token as used
    await db
      .update(onboardTokens)
      .set({ usedAt: new Date() })
      .where(eq(onboardTokens.id, record.id));

    // Create or find soft DID
    // Check for existing credential to reuse DID (prevents duplicates)
    const normalizedEmail = record.email.toLowerCase().trim();
    const [existingCred] = await db
      .select({ did: credentials.did })
      .from(credentials)
      .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalizedEmail)))
      .limit(1);

    let did: string;

    let [identity] = existingCred
      ? await db.select().from(identities).where(eq(identities.id, existingCred.did)).limit(1)
      : [];

    if (identity) {
      did = identity.id;
      if (record.name && !identity.name) {
        // Update name if provided and not already set
        [identity] = await db
          .update(identities)
          .set({ name: record.name, updatedAt: new Date() })
          .where(eq(identities.id, did))
          .returning();
      }
    } else {
      // Mint a new stable DID
      did = `did:imajin:${nanoid(16)}`;
      const placeholderKey = `soft_${nanoid(32)}`;
      [identity] = await db
        .insert(identities)
        .values({
          id: did,
          type: 'human',
          publicKey: placeholderKey,
          handle: null,
          name: record.name || null,
          metadata: { email: record.email, tier: 'soft', source: 'onboard' },
        })
        .returning();
      // Insert email credential
      await db.insert(credentials).values({
        id: `cred_${nanoid(16)}`,
        did,
        type: 'email',
        value: normalizedEmail,
        verifiedAt: new Date(),
      });
    }

    // Create session token
    const sessionToken = await createSessionToken({
      sub: did,
      type: 'human',
      tier: 'soft',
      handle: identity.handle || undefined,
      name: identity.name || undefined,
    });

    // Set cookie and redirect
    const cookieOptions = getSessionCookieOptions();

    const redirectUrl = record.redirectUrl || '/';
    const response = NextResponse.redirect(redirectUrl);

    response.cookies.set(
      cookieOptions.name,
      sessionToken,
      cookieOptions.options,
    );

    emitSessionAttestation({
      did,
      method: "email_onboard",
      tier: "soft",
      userAgent: request.headers.get("user-agent"),
    }).catch(err => console.error("Session attestation error:", err));

    return response;

  } catch (error) {
    console.error('Onboard verify error:', error);
    return errorPage('Verification Error', 'Something went wrong verifying your email. Please try again.');
  }
}

function errorPage(title: string, message: string): NextResponse {
  return new NextResponse(
    `<!DOCTYPE html>
<html>
<head><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui;max-width:500px;margin:80px auto;padding:20px;text-align:center;background:#000;color:#e4e4e7;}h1{color:#ef4444;font-size:24px;}p{color:#a1a1aa;line-height:1.6;}</style>
</head>
<body><h1>${title}</h1><p>${message}</p></body>
</html>`,
    { status: 400, headers: { 'Content-Type': 'text/html' } }
  );
}
