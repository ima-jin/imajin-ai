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
 * Returns: { sub, aud, scopes, actingAs? }
 *   scopes — those honoured at the verified `aud` (#2674): everything on the
 *            token at its primary audience, only the listed dependency scopes
 *            at a dependency audience.
 *
 * `actingAs` (#2639 / #2644) is the group DID the token was minted to act as. The
 * group authority was checked once at mint; here we only re-apply what the registry
 * already re-applies to the app on every verify. Act-as honours that revocation: if
 * the app lost its operator act-as approval the token stops verifying (403) rather
 * than silently degrading to the user's own DID. The claim is surfaced only for the
 * app's own audience, never when verified as a dependency audience (#2663).
 *
 * This is the transport `verifyAppToken` (@imajin/auth) calls into. See
 * apps/kernel/src/lib/auth/jwt.ts for the session-vs-app-DID token distinction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { scopesForAudience } from '@imajin/auth';
import { verifySessionAppTokenLocal } from '@/src/lib/auth/jwt';
import { resolveActiveAppByAudience, appNotRegisteredResponse } from '@/src/lib/kernel/app-registry';
import { ACT_AS_NOT_APPROVED_ERROR } from '@/src/lib/kernel/app-act-as';

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

  // #1990: re-check the token's own `aud` against the registry on every
  // verify call, not just at mint time. This is what makes revoking an app
  // take effect within one verify cycle — a token minted before revocation
  // stops verifying on its very next use, rather than staying valid for the
  // rest of its (short) TTL.
  //
  // #2663: a token may carry several audiences (the app plus its `dependsOn`
  // services). EVERY one must still resolve to an active app, so revoking
  // either end stops the token verifying at both.
  const registered = await Promise.all(claims.auds.map((a) => resolveActiveAppByAudience(a)));
  if (registered.some((app) => !app)) {
    return appNotRegisteredResponse(request);
  }

  // #2639: the minting app is the token's primary audience (always first). A token
  // carrying an act-as claim is only valid while that app is still approved for it.
  let actingAs = claims.actingAs;
  if (actingAs) {
    if (!registered[0]?.actAsAllowed) {
      return NextResponse.json(ACT_AS_NOT_APPROVED_ERROR, { status: 403, headers: cors });
    }
    // Narrowest reading: act-as belongs to the minting app's own audience.
    if (claims.aud !== claims.auds[0]) actingAs = undefined;
  }

  // #2674: scopes ride on the token as one flat list, but each dependency's
  // listed scopes belong to ITS audience only. Verifying for a dependency
  // honours just the scopes the primary app's `dependsOn` lists for it, so a
  // token with two dependency audiences can't use A's scopes at B (nor the
  // app's own `providesScopes` at either). The primary audience is `auds[0]`.
  const primaryApp = registered[0];
  const scopes = scopesForAudience(claims.aud, claims.auds[0], claims.scopes, primaryApp?.dependsOn ?? []);

  if (body.scope && !scopes.includes(body.scope)) {
    return NextResponse.json({ error: `Scope '${body.scope}' was not granted` }, { status: 403, headers: cors });
  }

  return NextResponse.json(
    { sub: claims.sub, aud: claims.aud, scopes, ...(actingAs ? { actingAs } : {}) },
    { headers: cors }
  );
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
