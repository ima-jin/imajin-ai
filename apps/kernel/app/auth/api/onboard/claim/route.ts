/**
 * POST /api/onboard/claim
 *
 * Claim a session via one-shot handoff token.
 * Body: { handoffToken }
 * Sets session cookie on the response (tab A context).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, onboardTokens, identities, credentials } from '@/src/db';
import { createSessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { eq, and, isNull } from 'drizzle-orm';
import { corsHeaders, rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';

const HANDOFF_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  // 60/min/IP. The handoffToken is single-use, nanoid(24), unguessable, and
  // expires in 5 minutes — the rate limit is defense-in-depth only. The
  // previous 20/min locked active testers out when polling loops across
  // tabs/flows produced rapid claim attempts.
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 60, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body = await request.json();
    const { handoffToken } = body;

    if (!handoffToken || typeof handoffToken !== 'string') {
      return NextResponse.json(
        { error: 'handoffToken is required' },
        { status: 400, headers: cors }
      );
    }

    const [record] = await db
      .select()
      .from(onboardTokens)
      .where(
        and(
          eq(onboardTokens.handoffToken, handoffToken),
          isNull(onboardTokens.handoffUsedAt),
        )
      )
      .limit(1);

    if (!record) {
      return NextResponse.json(
        { error: 'Invalid or expired handoff token' },
        { status: 400, headers: cors }
      );
    }

    // Check handoff TTL
    if (!record.usedAt) {
      return NextResponse.json(
        { error: 'Invalid handoff token' },
        { status: 400, headers: cors }
      );
    }
    const handoffAge = Date.now() - new Date(record.usedAt).getTime();
    if (handoffAge > HANDOFF_TTL_MS) {
      return NextResponse.json(
        { error: 'Handoff token expired' },
        { status: 410, headers: cors }
      );
    }

    // Resolve DID from the email on the record
    const normalizedEmail = record.email.toLowerCase().trim();
    const [existingCred] = await db
      .select({ did: credentials.did })
      .from(credentials)
      .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalizedEmail)))
      .limit(1);

    if (!existingCred?.did) {
      return NextResponse.json(
        { error: 'Identity not found for this token' },
        { status: 404, headers: cors }
      );
    }

    const [identity] = await db
      .select()
      .from(identities)
      .where(eq(identities.id, existingCred.did))
      .limit(1);

    if (!identity) {
      return NextResponse.json(
        { error: 'Identity not found' },
        { status: 404, headers: cors }
      );
    }

    // Mark handoff as used (single-use)
    await db
      .update(onboardTokens)
      .set({ handoffUsedAt: new Date() })
      .where(eq(onboardTokens.id, record.id));

    // Mint session token
    const identityTier = (identity.tier || 'soft') as 'soft' | 'preliminary' | 'established';
    const sessionToken = await createSessionToken({
      sub: identity.id,
      scope: identity.scope || 'actor',
      subtype: identity.subtype || 'human',
      tier: identityTier,
      handle: identity.handle || undefined,
      name: identity.name || undefined,
    });

    // Set cookie on this response (tab A context)
    const cookieOptions = getSessionCookieOptions();
    const response = NextResponse.json(
      { success: true },
      { headers: cors }
    );
    response.cookies.set(cookieOptions.name, sessionToken, cookieOptions.options);

    // Set active forest cookie if scoped
    if (record.scopeDid) {
      response.cookies.set('x-acting-as', record.scopeDid, { path: '/', maxAge: 31536000, sameSite: 'lax' });
    }

    return response;

  } catch (error) {
    log.error({ err: String(error) }, 'Onboard claim error');
    return NextResponse.json(
      { error: 'Failed to claim session' },
      { status: 500, headers: cors }
    );
  }
});
