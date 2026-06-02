/**
 * POST /auth/api/apps/token  (#1069 / #799 P3)
 *
 * Mint a short-lived, scoped app token. Replaces passing the raw attestationId
 * around as a long-lived bearer.
 *
 * The app proves possession of its keypair (signature over a challenge that
 * includes the attestationId + a fresh nonce + timestamp), the kernel validates
 * the user's `app.authorized` attestation, then mints a ~10min EdDSA token that
 * downstream services verify locally against the kernel public key.
 *
 * Body: {
 *   appDid: string,
 *   attestationId: string,
 *   scope?: string,          // optional single scope to narrow to (must be granted)
 *   aud?: string,            // optional target service
 *   nonce: string,           // client-generated, >= 16 chars
 *   timestamp: string,       // ISO; must be within 60s
 *   signature: string        // ed25519 hex over `${appDid}:${attestationId}:${nonce}:${timestamp}`
 * }
 * Returns: { token, expiresIn, scopes }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, identities } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { createDbResolver } from '@imajin/auth';
import { verifySignature } from '@/src/lib/auth/crypto';
import { createAppToken } from '@/src/lib/auth/jwt';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const resolveDid = createDbResolver(db, identities);

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

  const { appDid, attestationId, scope, aud, nonce, timestamp, signature } = body as {
    appDid?: string;
    attestationId?: string;
    scope?: string;
    aud?: string;
    nonce?: string;
    timestamp?: string;
    signature?: string;
  };

  if (!appDid || !attestationId || !nonce || !timestamp || !signature) {
    return NextResponse.json(
      { error: 'appDid, attestationId, nonce, timestamp, signature are required' },
      { status: 400, headers: cors }
    );
  }

  if (nonce.length < 16) {
    return NextResponse.json({ error: 'nonce too short' }, { status: 400, headers: cors });
  }

  // Freshness: reject stale/future timestamps (replay window bound)
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
    return NextResponse.json({ error: 'timestamp outside allowed window' }, { status: 401, headers: cors });
  }

  // Proof of possession: app must sign with its own key
  const resolved = await resolveDid(appDid);
  if (!resolved?.publicKey) {
    return NextResponse.json({ error: 'Unknown app DID' }, { status: 404, headers: cors });
  }

  const challenge = `${appDid}:${attestationId}:${nonce}:${timestamp}`;
  const pop = await verifySignature(challenge, signature, resolved.publicKey);
  if (!pop) {
    return NextResponse.json({ error: 'Invalid proof-of-possession signature' }, { status: 401, headers: cors });
  }

  // Validate the user's authorization attestation (same checks as /apps/validate)
  const [att] = await db
    .select()
    .from(attestations)
    .where(
      and(
        eq(attestations.id, attestationId),
        eq(attestations.subjectDid, appDid),
        eq(attestations.type, 'app.authorized'),
      )
    );

  if (!att) {
    return NextResponse.json({ error: 'Authorization not found' }, { status: 404, headers: cors });
  }
  if (att.revokedAt) {
    return NextResponse.json({ error: 'Authorization has been revoked' }, { status: 403, headers: cors });
  }

  const payload = att.payload as { scopes?: string[] } | null;
  const approvedScopes = payload?.scopes ?? [];

  // If the app narrows to a single scope, it must be one of the granted ones.
  if (scope && !approvedScopes.includes(scope)) {
    return NextResponse.json({ error: `Scope '${scope}' was not granted` }, { status: 403, headers: cors });
  }

  const grantedScopes = scope ? [scope] : approvedScopes;

  const token = await createAppToken({
    sub: att.issuerDid,
    azp: appDid,
    scope: grantedScopes.join(' '),
    aud,
    attestationId,
  });

  log.info({ appDid, userDid: att.issuerDid, scopes: grantedScopes }, 'minted app token');

  return NextResponse.json(
    { token, expiresIn: 600, scopes: grantedScopes },
    { headers: cors }
  );
}
