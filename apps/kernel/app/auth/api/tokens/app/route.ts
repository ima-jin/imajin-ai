/**
 * POST /auth/api/tokens/app  (#1069 Phase 1)
 *
 * Mint a short-lived, host-scoped app token from the CALLER'S OWN first-party
 * session — the other half of #1069's app-token model. `/auth/api/apps/token`
 * mints a token for a THIRD-PARTY app that already holds a user's
 * `app.authorized` attestation; this endpoint mints one for a FIRST-PARTY app
 * the signed-in user is about to visit, so that app can stop reading the
 * shared session cookie directly (see docs/security/cookie-isolation.md,
 * "Path A" / "Path B").
 *
 * Body: { aud: string, scopes?: string[] }
 *   aud    — the target app host this token is scoped to (required)
 *   scopes — requested scopes, clamped to the SCOPES vocabulary (default: [])
 *
 * Returns: { token, expiresIn, scopes }
 *
 * This is a Phase 1 primitive: shipping it does not change any existing
 * app's default auth behavior. Nothing calls this endpoint unless an app
 * explicitly opts in via `requireSessionOrAppToken` (@imajin/auth).
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, getSessionCookieOptions } from '@imajin/config';
import { validateScopes } from '@imajin/auth';
import { verifySessionToken, createSessionAppToken } from '@/src/lib/auth/jwt';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const cookieConfig = getSessionCookieOptions();
  const sessionToken = request.cookies.get(cookieConfig.name)?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
  }

  const session = await verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401, headers: cors });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { aud, scopes } = body as { aud?: string; scopes?: string[] };
  if (!aud || typeof aud !== 'string') {
    return NextResponse.json({ error: 'aud is required' }, { status: 400, headers: cors });
  }

  const { valid: grantedScopes } = validateScopes(Array.isArray(scopes) ? scopes : []);

  const token = await createSessionAppToken({ sub: session.sub, aud, scopes: grantedScopes });

  log.info({ did: session.sub, aud, scopes: grantedScopes }, 'minted session app token');

  return NextResponse.json(
    { token, expiresIn: 600, scopes: grantedScopes },
    { headers: cors }
  );
}
