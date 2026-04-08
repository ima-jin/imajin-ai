import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, mfaMethods } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { verifyEmailMfaCode } from '@/src/lib/auth/email-mfa-codes';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/mfa/email/verify-setup
 * Verify the setup code and activate email MFA.
 * Requires authentication and a prior call to /api/mfa/email/setup.
 *
 * Body: { code: string }
 * Returns: { success: true }
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

    const valid = verifyEmailMfaCode(session.sub, code);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid or expired code' }, { status: 401, headers: cors });
    }

    // Remove any existing email MFA method (idempotent re-setup)
    await db
      .delete(mfaMethods)
      .where(
        and(
          eq(mfaMethods.did, session.sub),
          eq(mfaMethods.type, 'email')
        )
      );

    // Insert verified email MFA method
    await db.insert(mfaMethods).values({
      id: `mfa_${nanoid(16)}`,
      did: session.sub,
      type: 'email',
      secret: 'email',
      name: 'Email code',
      verifiedAt: new Date(),
    });

    return NextResponse.json({ success: true }, { headers: cors });

  } catch (error) {
    console.error('[mfa/email/verify-setup] POST error:', error);
    return NextResponse.json({ error: 'Failed to verify setup code' }, { status: 500, headers: cors });
  }
}
