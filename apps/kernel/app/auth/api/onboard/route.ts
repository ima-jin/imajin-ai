/**
 * POST /api/onboard
 *
 * Initiate email verification for anonymous → soft DID onboarding.
 * Sends a verification email with a magic link.
 *
 * Body: { email, name?, redirectUrl?, context? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { onboardTokens } from '@/src/db';
import { sendEmail } from '@imajin/email';
import { nanoid } from 'nanoid';
import { corsHeaders } from '@imajin/config';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';
import { withLogger } from '@imajin/logger';

const AUTH_URL = process.env.AUTH_URL || process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 5, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body = await request.json();
    const { email, name, redirectUrl, context, scopeDid } = body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Valid email required' },
        { status: 400, headers: cors }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();
    const token = nanoid(48);
    const id = `obt_${nanoid(16)}`;

    // Store token (15 minute TTL)
    await db.insert(onboardTokens).values({
      id,
      email: normalizedEmail,
      name: name?.trim() || null,
      token,
      redirectUrl: redirectUrl || null,
      context: context || null,
      scopeDid: scopeDid || null,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    // Build verification link
    const verifyUrl = `${AUTH_URL}/api/onboard/verify?token=${token}`;

    // Send verification email
    const contextText = context ? ` to ${context}` : '';
    const result = await sendEmail({
      to: normalizedEmail,
      subject: `Verify your email${contextText} — Imajin`,
      html: onboardEmail({ verifyUrl, context, name: name?.trim() }),
    });

    if (!result.success) {
      log.error({ err: String(result.error) }, 'Failed to send onboard email');
      return NextResponse.json(
        { error: 'Failed to send verification email' },
        { status: 502, headers: cors }
      );
    }

    return NextResponse.json({ sent: true }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, 'Onboard start error');
    return NextResponse.json(
      { error: 'Failed to initiate onboarding' },
      { status: 500, headers: cors }
    );
  }
});

function onboardEmail({ verifyUrl, context, name }: { verifyUrl: string; context?: string; name?: string }): string {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const contextLine = context ? `<p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">You're about to <strong style="color:#ffffff;">${context}</strong>. Verify your email to continue.</p>` : '<p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">Verify your email to continue.</p>';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000;">
    <tr>
      <td align="center" style="padding:20px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <tr>
            <td style="background-color:#111111;border-radius:8px;padding:32px;">
              <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;">${greeting}</p>
              ${contextLine}
              <div style="text-align:center;margin:32px 0;">
                <a href="${verifyUrl}" style="display:inline-block;background-color:#f59e0b;color:#000000;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Verify Email & Continue →</a>
              </div>
              <p style="margin:0;font-size:13px;color:#52525b;text-align:center;">This link expires in 15 minutes.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:2px;">IMAJIN</p>
              <p style="margin:0;font-size:12px;color:#52525b;">The internet that pays you back</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}
