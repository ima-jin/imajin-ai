import { NextRequest, NextResponse } from 'next/server';
import { db, mfaMethods } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/mfa/email/disable
 * Disable email MFA for the authenticated user.
 *
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

    await db
      .delete(mfaMethods)
      .where(
        and(
          eq(mfaMethods.did, session.sub),
          eq(mfaMethods.type, 'email')
        )
      );

    return NextResponse.json({ success: true }, { headers: cors });

  } catch (error) {
    console.error('[mfa/email/disable] POST error:', error);
    return NextResponse.json({ error: 'Failed to disable email MFA' }, { status: 500, headers: cors });
  }
}
