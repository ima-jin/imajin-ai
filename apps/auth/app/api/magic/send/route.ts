/**
 * POST /api/magic/send
 *
 * Send a magic link to re-authenticate. Works for both soft and hard DIDs
 * as long as the email exists in auth.credentials or profile.profiles.
 *
 * Body: { email, redirectUrl? }
 *
 * Always returns { sent: true } to prevent email enumeration.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { onboardTokens, credentials } from '@/src/db/schema';
import { sendEmail } from '@imajin/email';
import { getClient } from '@imajin/db';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { corsHeaders } from '@imajin/config';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';

const AUTH_URL = process.env.AUTH_URL || process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
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
    const { email, redirectUrl } = body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Valid email required' },
        { status: 400, headers: cors }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Look up DID by email credential
    const [cred] = await db
      .select({ did: credentials.did })
      .from(credentials)
      .where(
        and(
          eq(credentials.type, 'email'),
          eq(credentials.value, normalizedEmail),
        )
      )
      .limit(1);

    let did = cred?.did;

    // Fallback: check profile.profiles.email for hard DIDs without a credential row
    if (!did) {
      const sql = getClient();
      const profileRows = await sql`
        SELECT did FROM profile.profiles WHERE email = ${normalizedEmail} LIMIT 1
      `;
      if (profileRows.length > 0) {
        did = profileRows[0].did;
      }
    }

    if (!did) {
      // No account found — return success anyway to prevent enumeration
      console.log(`Magic link requested for unknown email: ${normalizedEmail}`);
      return NextResponse.json({ sent: true }, { headers: cors });
    }

    // Mint onboard token
    const token = nanoid(48);
    const id = `obt_${nanoid(16)}`;

    await db.insert(onboardTokens).values({
      id,
      email: normalizedEmail,
      name: null,
      token,
      redirectUrl: redirectUrl || null,
      context: 'log back in',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    });

    const verifyUrl = `${AUTH_URL}/api/onboard/verify?token=${token}`;

    await sendEmail({
      to: normalizedEmail,
      subject: 'Your login link — Imajin',
      html: magicLinkEmail({ verifyUrl }),
    });

    return NextResponse.json({ sent: true }, { headers: cors });

  } catch (error) {
    console.error('Magic link send error:', error);
    return NextResponse.json(
      { error: 'Failed to send login link' },
      { status: 500, headers: cors }
    );
  }
}

function magicLinkEmail({ verifyUrl }: { verifyUrl: string }): string {
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
              <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;">Hi,</p>
              <p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">Click below to log in. No password needed.</p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${verifyUrl}" style="display:inline-block;background-color:#f59e0b;color:#000000;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Log In →</a>
              </div>
              <p style="margin:0;font-size:13px;color:#52525b;text-align:center;">This link expires in 15 minutes. If you didn't request this, you can ignore it.</p>
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
