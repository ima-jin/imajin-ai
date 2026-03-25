import { NextRequest, NextResponse } from 'next/server';
import { verify as totpVerify } from 'otplib';
import { db } from '@/src/db';
import { mfaMethods } from '@/src/db/schema';
import { eq, and, isNotNull } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { decryptSecret } from '@/lib/encrypt';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/mfa/totp/challenge
 * Verify a TOTP code during the login flow (MFA step).
 * Requires an active session (partial login) or an authenticated session.
 *
 * Body: { code: string }
 * Returns: { verified: true }
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const cookieConfig = getSessionCookieOptions();
    const token = request.cookies.get(cookieConfig.name)?.value;
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
    }
    const session = await verifySessionToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401, headers: cors });
    }

    const body = await request.json();
    const { code } = body;
    if (!code) {
      return NextResponse.json({ error: 'code required' }, { status: 400, headers: cors });
    }

    // Find the active (verified) TOTP method
    const methods = await db
      .select()
      .from(mfaMethods)
      .where(
        and(
          eq(mfaMethods.did, session.sub),
          eq(mfaMethods.type, 'totp'),
          isNotNull(mfaMethods.verifiedAt)
        )
      )
      .limit(1);

    if (methods.length === 0) {
      return NextResponse.json({ error: 'No active TOTP method found' }, { status: 400, headers: cors });
    }

    const method = methods[0];
    const secret = decryptSecret(method.secret);
    const result = await totpVerify({ token: code, secret });

    if (!result.valid) {
      return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401, headers: cors });
    }

    await db
      .update(mfaMethods)
      .set({ lastUsedAt: new Date() })
      .where(eq(mfaMethods.id, method.id));

    return NextResponse.json({ verified: true }, { headers: cors });

  } catch (error) {
    console.error('[mfa/totp/challenge] POST error:', error);
    return NextResponse.json({ error: 'Failed to verify TOTP challenge' }, { status: 500, headers: cors });
  }
}
