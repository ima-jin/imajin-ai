/**
 * GET /profile/api/contact/verify-email/confirm
 *
 * Confirmation link handler — called when the owner clicks the link from the
 * verification email. Validates the HMAC token, issues an `email_verified`
 * attestation, backfills auth.credentials, then redirects to the profile edit
 * page with `?verified=email`.
 *
 * Query params (all required):
 *   did   — the owner DID
 *   exp   — expiry Unix-ms timestamp
 *   tok   — HMAC-SHA256(AUTH_PRIVATE_KEY, "{did}:{exp}") base64url
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { loadAndUnseal } from '@/src/lib/vault';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const AUTH_INTERNAL_URL = process.env.AUTH_INTERNAL_URL ?? process.env.NEXT_PUBLIC_AUTH_URL ?? 'https://auth.imajin.ai';
const PROFILE_URL = process.env.NEXT_PUBLIC_PROFILE_URL ?? process.env.NEXT_PUBLIC_AUTH_URL ?? 'https://auth.imajin.ai';
const ATTESTATION_INTERNAL_API_KEY = process.env.ATTESTATION_INTERNAL_API_KEY ?? '';

function verifyToken(did: string, exp: number, tok: string): boolean {
  const privateKey = process.env.AUTH_PRIVATE_KEY ?? 'dev-verify-key';
  const message = `${did}:${exp}`;
  const expected = createHmac('sha256', privateKey).update(message).digest('base64url');
  try {
    const a = Buffer.from(tok);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const did = searchParams.get('did');
  const expStr = searchParams.get('exp');
  const tok = searchParams.get('tok');

  const editUrl = `${PROFILE_URL}/profile/edit`;

  if (!did || !expStr || !tok) {
    return NextResponse.redirect(`${editUrl}?verified=invalid`);
  }

  const exp = Number.parseInt(expStr, 10);
  if (Number.isNaN(exp) || Date.now() > exp) {
    return NextResponse.redirect(`${editUrl}?verified=expired`);
  }

  if (!verifyToken(did, exp, tok)) {
    return NextResponse.redirect(`${editUrl}?verified=invalid`);
  }

  // Re-read email from vault (never exposed via URL param)
  let email: string | undefined;
  try {
    email = await loadAndUnseal(`contact:email:${did}`);
  } catch (err) {
    log.error({ err: String(err), did }, 'Failed to unseal contact email at confirm');
    return NextResponse.redirect(`${editUrl}?verified=error`);
  }

  if (!email) {
    return NextResponse.redirect(`${editUrl}?verified=no-email`);
  }

  const normalised = email.toLowerCase().trim();
  const emailHash = createHash('sha256').update(normalised).digest('hex');

  // Issue email_verified attestation via the internal endpoint (server-signed)
  const nodeIdentity = getNodeSigningIdentity();
  try {
    const attestRes = await fetch(`${AUTH_INTERNAL_URL}/auth/api/attestations/internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ATTESTATION_INTERNAL_API_KEY}`,
      },
      body: JSON.stringify({
        issuer_did: nodeIdentity.senderDid,
        subject_did: did,
        type: 'email_verified',
        payload: { email_hash: emailHash },
      }),
    });

    if (!attestRes.ok) {
      const body = await attestRes.text().catch(() => '');
      log.error({ status: attestRes.status, body, did }, 'Attestation issuance failed at verify-email confirm');
      return NextResponse.redirect(`${editUrl}?verified=error`);
    }
  } catch (err) {
    log.error({ err: String(err), did }, 'Network error issuing email_verified attestation');
    return NextResponse.redirect(`${editUrl}?verified=error`);
  }

  // Backfill auth.credentials so the magic-link login path can find this DID by email
  try {
    const sql = getClient();
    await sql`
      INSERT INTO auth.credentials (id, did, type, value, verified_at)
      VALUES (
        ${'cred_' + createHash('sha256').update(did + normalised).digest('hex').slice(0, 24)},
        ${did},
        'email',
        ${normalised},
        now()
      )
      ON CONFLICT (type, value) DO UPDATE
        SET verified_at = now()
      WHERE auth.credentials.did = ${did}
    `;
  } catch (err) {
    // Non-fatal — login fallback still works; log and continue
    log.warn({ err: String(err), did }, 'credentials backfill failed at verify-email confirm');
  }

  return NextResponse.redirect(`${editUrl}?verified=email`);
}
