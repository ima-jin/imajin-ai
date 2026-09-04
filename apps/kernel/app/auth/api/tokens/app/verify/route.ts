/**
 * POST /auth/api/tokens/app/verify  (#1069 Phase 1)
 *
 * Stateless verification of a session-scoped app token minted by
 * `POST /auth/api/tokens/app`. Checks the EdDSA signature, expiry, and `typ`
 * locally (no DB hit) and — when `aud` is supplied — that the token was
 * minted for that exact host, so a token minted for one app can never verify
 * for another.
 *
 * Body: { token: string, aud?: string, scope?: string }
 * Returns: { sub, aud, scopes }
 *
 * This is the transport `verifyAppToken` (@imajin/auth) calls into. See
 * apps/kernel/src/lib/auth/jwt.ts for the session-vs-app-DID token distinction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { verifySessionAppTokenLocal } from '@/src/lib/auth/jwt';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  let body: { token?: string; aud?: string; scope?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  if (!body.token) {
    return NextResponse.json({ error: 'token required' }, { status: 400, headers: cors });
  }

  const claims = await verifySessionAppTokenLocal(body.token, body.aud);
  if (!claims) {
    return NextResponse.json(
      { error: 'Invalid, expired, or mismatched-audience token' },
      { status: 401, headers: cors }
    );
  }

  if (body.scope && !claims.scopes.includes(body.scope)) {
    return NextResponse.json({ error: `Scope '${body.scope}' was not granted` }, { status: 403, headers: cors });
  }

  return NextResponse.json(
    { sub: claims.sub, aud: claims.aud, scopes: claims.scopes },
    { headers: cors }
  );
}
