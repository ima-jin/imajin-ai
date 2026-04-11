import { NextRequest, NextResponse } from 'next/server';
import { db, credentials } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { generateEmailMfaCode, storeEmailMfaCode } from '@/src/lib/auth/email-mfa-codes';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/mfa/email/setup
 * Send a 6-digit setup code to the user's registered email.
 * Requires authentication. Call /api/mfa/email/verify-setup afterwards to activate.
 *
 * Returns: { sent: true }
 */
export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
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

    // Check user has an email credential
    const emailCreds = await db
      .select({ value: credentials.value })
      .from(credentials)
      .where(
        and(
          eq(credentials.did, session.sub),
          eq(credentials.type, 'email')
        )
      )
      .limit(1);

    if (emailCreds.length === 0) {
      return NextResponse.json({ error: 'No email credential found for this account' }, { status: 400, headers: cors });
    }

    // Generate and store code
    const code = generateEmailMfaCode();
    storeEmailMfaCode(session.sub, code);

    // Send email (non-fatal)
    try {
      const { sendEmail } = await import('@imajin/email');
      await sendEmail({
        to: emailCreds[0].value,
        subject: 'Your Imajin verification code',
        html: `<p>Your verification code is: <strong>${code}</strong></p><p>This code expires in 5 minutes.</p>`,
        text: `Your verification code is: ${code}\n\nThis code expires in 5 minutes.`,
      });
    } catch (err) {
      log.error({ err: String(err) }, '[mfa/email/setup] Email send failed (non-fatal)');
    }

    return NextResponse.json({ sent: true }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, '[mfa/email/setup] POST error');
    return NextResponse.json({ error: 'Failed to send setup code' }, { status: 500, headers: cors });
  }
});
