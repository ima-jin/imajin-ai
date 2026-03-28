import { NextRequest, NextResponse } from 'next/server';
import { db, credentials } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { verifyMfaChallengeToken } from '@/lib/jwt';
import { generateEmailMfaCode, storeEmailMfaCode } from '@/lib/email-mfa-codes';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/mfa/email/send
 * Send a 6-digit MFA code to the user's registered email.
 *
 * Body: { challengeToken: string }
 * Returns: { sent: true } (always, to prevent email enumeration)
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const body = await request.json();
    const { challengeToken } = body;

    if (!challengeToken) {
      return NextResponse.json({ error: 'challengeToken required' }, { status: 400, headers: cors });
    }

    // Verify challenge token
    const challenge = await verifyMfaChallengeToken(challengeToken);
    if (!challenge) {
      return NextResponse.json({ error: 'Invalid or expired challenge token' }, { status: 401, headers: cors });
    }

    if (!challenge.methods.includes('email')) {
      return NextResponse.json({ error: 'Email MFA not available for this challenge' }, { status: 400, headers: cors });
    }

    // Generate and store code
    const code = generateEmailMfaCode();
    storeEmailMfaCode(challenge.sub, code);

    // Try to send email (non-fatal)
    try {
      // Look up email credential for this DID
      const emailCreds = await db
        .select({ value: credentials.value })
        .from(credentials)
        .where(
          and(
            eq(credentials.did, challenge.sub),
            eq(credentials.type, 'email')
          )
        )
        .limit(1);

      if (emailCreds.length > 0) {
        const { sendEmail } = await import('@imajin/email');
        await sendEmail({
          to: emailCreds[0].value,
          subject: 'Your Imajin verification code',
          html: `<p>Your verification code is: <strong>${code}</strong></p><p>This code expires in 5 minutes.</p>`,
          text: `Your verification code is: ${code}\n\nThis code expires in 5 minutes.`,
        });
      }
    } catch (err) {
      console.error('[mfa/email/send] Email send failed (non-fatal):', err);
    }

    return NextResponse.json({ sent: true }, { headers: cors });

  } catch (error) {
    console.error('[mfa/email/send] POST error:', error);
    return NextResponse.json({ error: 'Failed to send email code' }, { status: 500, headers: cors });
  }
}
