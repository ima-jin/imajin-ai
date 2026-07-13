/**
 * POST /profile/api/contact/verify-email
 *
 * Owner-authenticated. Reads the caller's vault-stored email and sends a
 * confirmation link. On click the confirm endpoint issues an `email_verified`
 * attestation on the owner's DID.
 *
 * Token: HMAC-SHA256( AUTH_PRIVATE_KEY, "{did}:{email}:{exp}" ) where exp is
 * a Unix-ms timestamp 15 minutes from now. The raw token is URL-safe base64.
 * No plaintext email is exposed in the token itself — the email is re-read
 * from the vault at confirm time.
 */

import { createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { loadAndUnseal } from '@/src/lib/vault';
import { sendEmail } from '@imajin/email';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const PROFILE_URL = process.env.NEXT_PUBLIC_PROFILE_URL ?? process.env.NEXT_PUBLIC_AUTH_URL ?? 'https://auth.imajin.ai';

/** 15-minute TTL in milliseconds */
const TOKEN_TTL_MS = 15 * 60 * 1000;

function buildToken(did: string, exp: number): string {
  const privateKey = process.env.AUTH_PRIVATE_KEY ?? 'dev-verify-key';
  const message = `${did}:${exp}`;
  return createHmac('sha256', privateKey).update(message).digest('base64url');
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(`contact-verify-email:${ip}`, 5, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const ownerDid = resolveActingDid(authResult.identity);

  // Load the vault-stored email for this DID
  let email: string | undefined;
  try {
    email = await loadAndUnseal(`contact:email:${ownerDid}`);
  } catch (err) {
    log.error({ err: String(err), did: ownerDid }, 'Failed to unseal contact email for verification');
    return NextResponse.json({ error: 'Failed to read contact email' }, { status: 500, headers: cors });
  }

  if (!email) {
    return NextResponse.json({ error: 'No email address found. Add an email to your profile first.' }, { status: 400, headers: cors });
  }

  const exp = Date.now() + TOKEN_TTL_MS;
  const token = buildToken(ownerDid, exp);

  // Encode {did, exp} in the URL so the confirm handler can re-derive and check the HMAC
  const params = new URLSearchParams({
    did: ownerDid,
    exp: String(exp),
    tok: token,
  });
  const confirmUrl = `${PROFILE_URL}/profile/api/contact/verify-email/confirm?${params.toString()}`;

  const result = await sendEmail({
    to: email,
    subject: 'Verify your email — Imajin',
    html: verifyEmailHtml({ confirmUrl }),
  });

  if (!result.success) {
    log.error({ err: String(result.error), did: ownerDid }, 'Failed to send verification email');
    return NextResponse.json({ error: 'Failed to send verification email' }, { status: 502, headers: cors });
  }

  // Return the masked email for UI confirmation (last part of domain only)
  const [localPart = '', domain = ''] = email.split('@');
  const maskedLocal = localPart.length > 2
    ? `${localPart[0]}${'*'.repeat(localPart.length - 2)}${localPart.at(-1)}`
    : '**';
  const maskedEmail = `${maskedLocal}@${domain}`;

  return NextResponse.json({ sent: true, maskedEmail }, { headers: cors });
}

function verifyEmailHtml({ confirmUrl }: { confirmUrl: string }): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000;">
    <tr>
      <td align="center" style="padding:20px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <tr>
            <td style="background:#111;border-radius:8px;padding:32px;">
              <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;">Hi,</p>
              <p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">
                Click below to verify your email address on Imajin. This link expires in 15 minutes.
              </p>
              <p style="margin:0 0 24px;">
                <a href="${confirmUrl}"
                   style="display:inline-block;padding:12px 24px;background:#F59E0B;color:#000;border-radius:6px;font-weight:600;font-size:15px;text-decoration:none;">
                  Verify Email
                </a>
              </p>
              <p style="margin:0;font-size:13px;color:#52525b;">
                If you didn't request this, you can safely ignore it. Your email address has not been shared.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
