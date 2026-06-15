/**
 * POST /api/onboard
 *
 * Initiate email verification for anonymous → soft DID onboarding.
 * Sends a verification email with a magic link.
 *
 * Body: { email, name?, redirectUrl?, context? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, onboardTokens, credentials, identities } from '@/src/db';
import { sendEmail } from '@imajin/email';
import { getClient } from '@imajin/db';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { corsHeaders, rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';

const AUTH_URL = process.env.AUTH_URL || process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  // IP-level guard: 20 req/min. Two paths funnel through here (#912):
  //   - new soft-DID onboarding (purchase / signup)
  //   - existing-account login (mode='login', replaces /api/magic/send)
  const ip = getClientIP(request);
  const ipRl = rateLimit(ip, 20, 60_000);
  if (ipRl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: ipRl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(ipRl.retryAfter) } }
    );
  }

  try {
    const body = await request.json();
    const { email, name, redirectUrl, context, scopeDid, wantPolling, mode } = body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Valid email required' },
        { status: 400, headers: cors }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Email-level guard: 3 verification emails per email address per hour.
    // Applied before any DB lookups so enumeration protection still holds
    // (unknown emails silently succeed in login mode but still consume a slot).
    const emailRl = rateLimit(`onboard-email:${normalizedEmail}`, 3, 3_600_000);
    if (emailRl.limited) {
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: emailRl.retryAfter },
        { status: 429, headers: { ...cors, 'Retry-After': String(emailRl.retryAfter) } }
      );
    }

    // mode='login' (used by MagicLinkButton): only send to existing accounts,
    // reject hard DIDs (they must authenticate by key, not email), and apply
    // email enumeration protection by returning { sent: true } silently when
    // no account is found. Onboarding flows (mode unset) accept any email and
    // mint a fresh soft DID on verify.
    if (mode === 'login') {
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

      let resolvedDid = cred?.did;

      if (!resolvedDid) {
        // Fallback: legacy profile.profiles contact_email lookup, with backfill
        // into credentials so the next call hits the fast path.
        const rawSql = getClient();
        const profileRows = await rawSql<{ did: string }[]>`
          SELECT did FROM profile.profiles
          WHERE LOWER(contact_email) = ${normalizedEmail}
          LIMIT 1
        `;
        if (profileRows.length > 0) {
          resolvedDid = profileRows[0].did;
          try {
            await db.insert(credentials).values({
              id: `cred_${nanoid(16)}`,
              did: resolvedDid,
              type: 'email',
              value: normalizedEmail,
              verifiedAt: new Date(),
            });
          } catch (e: unknown) {
            // 23505 = unique violation; harmless race.
            const code = (e as { code?: string } | null)?.code;
            if (code !== '23505') throw e;
          }
        }
      }

      if (!resolvedDid) {
        // Unknown email — silently succeed to prevent enumeration.
        log.info({ email: normalizedEmail }, 'Login requested for unknown email');
        return NextResponse.json({ sent: true }, { headers: cors });
      }

      const [identity] = await db
        .select({ tier: identities.tier })
        .from(identities)
        .where(eq(identities.id, resolvedDid))
        .limit(1);

      if (identity && identity.tier !== 'soft') {
        return NextResponse.json(
          { error: 'This account requires private key authentication. Use your backup key file to log in.' },
          { status: 403, headers: cors }
        );
      }
    }

    const token = nanoid(48);
    const id = `obt_${nanoid(16)}`;
    const pollHandle = wantPolling === true ? nanoid(24) : null;

    // Store token (15 minute TTL)
    await db.insert(onboardTokens).values({
      id,
      email: normalizedEmail,
      name: name?.trim() || null,
      token,
      redirectUrl: redirectUrl || null,
      context: context || null,
      scopeDid: scopeDid || null,
      pollHandle,
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

    return NextResponse.json(
      { sent: true, ...(pollHandle ? { pollHandle } : {}) },
      { headers: cors }
    );

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
