/**
 * GET /api/onboard/verify?token=xxx
 *
 * Complete email verification: mint soft DID, set session cookie, redirect.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { onboardTokens, identities } from '@/src/db/schema';
import { createSessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');

    if (!token) {
      return errorPage('Invalid Link', 'This link is missing a verification token.');
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
      return errorPage('Link Expired or Invalid', 'This verification link has expired or has already been used. Please try again.');
    }

    // Mark token as used
    await db
      .update(onboardTokens)
      .set({ usedAt: new Date() })
      .where(eq(onboardTokens.id, record.id));

    // Create or find soft DID
    const emailSlug = record.email.replace(/@/g, '_at_').replace(/\./g, '_');
    const did = `did:email:${emailSlug}`;

    let [identity] = await db
      .select()
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);

    if (!identity) {
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
    } else if (record.name && !identity.name) {
      // Update name if provided and not already set
      [identity] = await db
        .update(identities)
        .set({ name: record.name, updatedAt: new Date() })
        .where(eq(identities.id, did))
        .returning();
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
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieOptions = getSessionCookieOptions(isProduction);

    // Create profile row if it doesn't exist
    const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL;
    if (PROFILE_SERVICE_URL) {
      try {
        await fetch(`${PROFILE_SERVICE_URL}/api/profile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${cookieOptions.name}=${sessionToken}`,
          },
          body: JSON.stringify({
            displayName: identity.name || record.name || record.email.split('@')[0],
            displayType: 'human',
          }),
        });
      } catch (err) {
        console.error('Profile creation failed (non-fatal):', err);
      }
    }

    const redirectUrl = record.redirectUrl || '/';
    const response = NextResponse.redirect(redirectUrl);

    response.cookies.set(
      cookieOptions.name,
      sessionToken,
      cookieOptions.options,
    );

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
