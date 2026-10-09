/**
 * Caller-identity resolution shared by the attestation route handlers
 * (POST/GET /api/attestations and POST /api/attestations/{id}/revoke).
 */

import type { NextRequest } from 'next/server';
import { db, tokens } from '@/src/db';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { verifySessionToken, verifySessionAppTokenLocal, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { resolveActiveAppByAudience } from '@/src/lib/kernel/app-registry';
import { resolveAppServiceCaller } from '@/src/lib/auth/app-service-caller';

/** The legacy full-identity Bearer token path (`auth.tokens`). */
async function resolveLegacyBearerDid(token: string): Promise<string | null> {
  const [tok] = await db
    .select({ identityId: tokens.identityId })
    .from(tokens)
    .where(
      and(
        eq(tokens.id, token),
        isNull(tokens.revokedAt),
        gt(tokens.expiresAt, new Date())
      )
    )
    .limit(1);
  return tok?.identityId ?? null;
}

/**
 * #2394: accept a session-scoped app token (minted by
 * POST /auth/api/tokens/app from the caller's own kernel session) as an
 * alternate Bearer credential — this is how a registered third-party app
 * authenticates an inbound call to this route on behalf of the user who
 * minted the token (Ryan's 2026-09-26 ruling: dykil's inbound auth is a
 * scoped app-token, verified the same way requireSessionOrAppToken does).
 * The token's `sub` (the minting user's own DID) becomes the caller
 * identity; its `aud` must still resolve to a live, active registered app
 * on every call (#1990), not just at mint time.
 *
 * #2674: a token may carry several audiences (the app plus its `dependsOn`
 * services, #2663). EVERY one must still resolve — the same per-audience check
 * `POST /auth/api/tokens/app/verify` makes — so revoking a dependency app stops
 * the token here too, not only the app named by its first audience.
 */
async function resolveSessionAppTokenDid(token: string): Promise<string | null> {
  const claims = await verifySessionAppTokenLocal(token);
  if (!claims) return null;
  const registered = await Promise.all(claims.auds.map((a) => resolveActiveAppByAudience(a)));
  return registered.every(Boolean) ? claims.sub : null;
}

/**
 * #2747: an app's own service token (`app-service+jwt`) authenticates as the
 * app itself — the caller DID is the app DID, never a user's. The app must
 * still be active in the registry on every call.
 */
async function resolveAppServiceDid(token: string): Promise<string | null> {
  return (await resolveAppServiceCaller(token))?.appDid ?? null;
}

/** Resolve calling identity from session cookie or Bearer token (legacy identity token, a scoped app token #2394, or an app's own service token #2747). */
export async function resolveCallerDid(request: NextRequest): Promise<string | null> {
  const cookieConfig = getSessionCookieOptions();
  const sessionToken = request.cookies.get(cookieConfig.name)?.value;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    if (session?.sub) return session.sub;
  }

  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    return (
      (await resolveLegacyBearerDid(token)) ??
      (await resolveSessionAppTokenDid(token)) ??
      (await resolveAppServiceDid(token))
    );
  }

  return null;
}
