/**
 * POST /auth/api/apps/token/service  (#1141)
 *
 * Mint an app-tier (keyholder) service token — no user delegation required.
 * Intended for registered daemons (e.g. broker-agent) that authenticate as
 * the app itself rather than on behalf of a specific user.
 *
 * The app proves possession of its keypair (signature over a challenge that
 * includes the appDid + a fresh nonce + timestamp). The kernel validates the
 * signature against the registered public key, then mints a ~10-min EdDSA
 * token with:
 *   - typ:  'app-service+jwt'
 *   - sub:  appDid  (no user)
 *   - azp:  appDid
 *   - scope: app's registered requestedScopes (clamped to SCOPES vocabulary)
 *
 * Security: service tokens carry NO userDid — they cannot impersonate a user.
 * Routes that accept service tokens must resolve the effective user separately
 * (e.g. via X-Acting-For header + channel-link lookup).
 *
 * Body: { appDid, nonce, timestamp, signature }
 *   appDid    — the app's registered DID
 *   nonce     — client-generated, >= 16 chars
 *   timestamp — ISO 8601; must be within 60 s of server time
 *   signature — Ed25519 hex over `${appDid}:${nonce}:${timestamp}`
 *
 * Returns: { token, expiresIn, scopes }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, registryApps } from '@/src/db';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { validateScopes } from '@imajin/auth';
import { verifySignature } from '@/src/lib/auth/crypto';
import { createAppServiceToken } from '@/src/lib/auth/jwt';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const MAX_CLOCK_SKEW_MS = 60_000;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { appDid, nonce, timestamp, signature } = body as {
    appDid?: string;
    nonce?: string;
    timestamp?: string;
    signature?: string;
  };

  if (!appDid || !nonce || !timestamp || !signature) {
    return NextResponse.json(
      { error: 'appDid, nonce, timestamp, signature are required' },
      { status: 400, headers: cors }
    );
  }

  if (nonce.length < 16) {
    return NextResponse.json({ error: 'nonce too short (min 16 chars)' }, { status: 400, headers: cors });
  }

  // Freshness: reject stale/future timestamps (replay window bound)
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
    return NextResponse.json({ error: 'timestamp outside allowed window' }, { status: 401, headers: cors });
  }

  // Look up app in registry — must be active
  const [app] = await db.select().from(registryApps).where(eq(registryApps.appDid, appDid));
  if (!app) {
    return NextResponse.json({ error: 'Unknown app DID' }, { status: 404, headers: cors });
  }
  if (app.status !== 'active') {
    return NextResponse.json({ error: 'App is not active' }, { status: 403, headers: cors });
  }

  // Proof of possession: app must sign with the keypair it registered
  const challenge = `${appDid}:${nonce}:${timestamp}`;
  const pop = await verifySignature(challenge, signature, app.publicKey);
  if (!pop) {
    return NextResponse.json({ error: 'Invalid proof-of-possession signature' }, { status: 401, headers: cors });
  }

  // Clamp app's registered scopes to the SCOPES vocabulary (ignore any stale/unknown scopes)
  const { valid: scopes } = validateScopes(app.requestedScopes ?? []);

  const token = await createAppServiceToken({
    azp: appDid,
    scope: scopes.join(' '),
  });

  log.info({ appDid, scopes }, 'minted app service token');

  return NextResponse.json({ token, expiresIn: 600, scopes }, { headers: cors });
}
