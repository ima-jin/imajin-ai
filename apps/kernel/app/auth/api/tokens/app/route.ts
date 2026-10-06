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
 *   scopes — requested scopes, clamped to the SCOPES vocabulary plus the scopes
 *            the target app declared in `registry.apps.provides_scopes`
 *            (#2663; default: [])
 *
 * Returns: { token, expiresIn, scopes, aud }
 *   aud — every audience the token carries: the requested `aud`, plus each
 *         `registry.apps.depends_on` audience the granted scopes reach
 *         (#2663), so one token can satisfy the app and e.g. kernel media.
 *
 * This is a Phase 1 primitive: shipping it does not change any existing
 * app's default auth behavior. Nothing calls this endpoint unless an app
 * explicitly opts in via `requireSessionOrAppToken` (@imajin/auth).
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, getSessionCookieOptions } from '@imajin/config';
import { resolveAppScopes } from '@imajin/auth';
import { verifySessionToken, createSessionAppToken } from '@/src/lib/auth/jwt';
import { resolveActiveAppByAudience, resolveTokenAudiences, appNotRegisteredResponse } from '@/src/lib/kernel/app-registry';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

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

  // #1990: the kernel refuses to mint a token for an audience nobody
  // registered. `aud` must resolve to an active registry.apps row's
  // token_audiences — an arbitrary caller-supplied string is no longer
  // sufficient, closing the gap this Phase 1 primitive originally shipped
  // with (any authenticated session could mint a token for any `aud`).
  const registeredApp = await resolveActiveAppByAudience(aud);
  if (!registeredApp) {
    return appNotRegisteredResponse(request);
  }

  // #2663: the platform vocabulary PLUS the scopes this app declared for
  // itself (`registry.apps.provides_scopes`) — e.g. dykil:read / dykil:write.
  // An app's own scopes are only ever granted on a token for that app's `aud`.
  const { valid: grantedScopes } = resolveAppScopes(
    Array.isArray(scopes) ? scopes : [],
    registeredApp.providesScopes,
  );

  // #2663: one token for the app AND the services it declared in `dependsOn`
  // (e.g. kernel media), so the app doesn't need a second token per service.
  const audiences = await resolveTokenAudiences(aud, registeredApp, grantedScopes);

  const token = await createSessionAppToken({ sub: session.sub, aud: audiences, scopes: grantedScopes });

  log.info({ did: session.sub, aud, audiences, scopes: grantedScopes }, 'minted session app token');

  return NextResponse.json(
    { token, expiresIn: 600, scopes: grantedScopes, aud: audiences },
    { headers: cors }
  );
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
