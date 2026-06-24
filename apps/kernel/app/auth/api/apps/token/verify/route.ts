/**
 * POST /auth/api/apps/token/verify  (#1069)
 *
 * Stateless verification of a short-lived app token. Checks the EdDSA signature
 * and expiry locally against the kernel public key — no DB lookup. Optionally
 * enforces that a required scope is present in the token's granted scopes.
 *
 * Accepts both user-delegated (app+jwt) and keyholder service (app-service+jwt)
 * tokens. For service tokens, userDid is returned as '' and isServiceToken is true.
 *
 * Body: { token: string, scope?: string }
 * Returns: { appDid, userDid, scopes, attestationId, isServiceToken? }  (AppAuthContext shape)
 *
 * Note: this is the interim transport for the local fast-path. Verification can
 * later move fully in-process in @imajin/auth (jose + published public key) to
 * remove this round-trip — tracked in #1069.
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { verifyAppToken } from '@/src/lib/auth/jwt';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  let body: { token?: string; scope?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  if (!body.token) {
    return NextResponse.json({ error: 'token required' }, { status: 400, headers: cors });
  }

  const payload = await verifyAppToken(body.token);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid or expired app token' }, { status: 401, headers: cors });
  }

  const scopes = payload.scope ? payload.scope.split(' ').filter(Boolean) : [];

  if (body.scope && !scopes.includes(body.scope)) {
    return NextResponse.json({ error: `Scope '${body.scope}' was not granted` }, { status: 403, headers: cors });
  }

  return NextResponse.json(
    {
      appDid: payload.azp,
      userDid: payload.isServiceToken ? '' : payload.sub,
      scopes,
      attestationId: payload.attestationId,
      ...(payload.isServiceToken ? { isServiceToken: true } : {}),
    },
    { headers: cors }
  );
}
