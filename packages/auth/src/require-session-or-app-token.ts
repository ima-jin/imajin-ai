import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

import { SESSION_COOKIE_NAME } from '@imajin/config';
import { verifyAppToken } from './app-token';

export interface SessionOrTokenAuth {
  /** DID of the authenticated caller (the token's `sub`, or the session's did). */
  did: string;
  /**
   * Capability scopes granted to this call. Always empty on the `cookie`
   * path — the shared session cookie predates scoped grants, so there is
   * nothing to enforce there. Callers that need scope enforcement must
   * require the `token` path (see `requireScopes`).
   */
  scopes: string[];
  /** Which path authenticated this request. */
  via: 'token' | 'cookie';
}

export type SessionOrTokenAuthResult =
  | { auth: SessionOrTokenAuth }
  | { error: string; status: number };

export interface SessionOrTokenAuthOptions {
  /**
   * This app's own host — the expected `aud` on the token path. Required so
   * a token minted for a different app can never be replayed here.
   */
  aud: string;
  /**
   * Scopes that must all be present. Only enforced on the `token` path —
   * see {@link SessionOrTokenAuth.scopes}.
   */
  requireScopes?: string[];
}

const getAuthUrl = () => process.env.AUTH_SERVICE_URL!;

function extractSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  const match = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  return match ? match.split('=')[1] || null : null;
}

/**
 * Validate the legacy shared session cookie against the kernel. Kept
 * self-contained (rather than reusing `require-auth.ts`'s private helper) —
 * this package already duplicates this exact pattern between
 * `require-auth.ts` and `session.ts`.
 */
async function validateLegacySessionCookie(token: string): Promise<string | null> {
  const authUrl = getAuthUrl();
  if (!authUrl) return null;
  try {
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did ?? data.identity?.did ?? null;
  } catch (err) {
    log.error({ err: String(err) }, '[AUTH] Legacy session cookie validation failed');
    return null;
  }
}

/**
 * Accept EITHER a scoped app token (`Authorization: Bearer`, preferred) OR
 * the legacy shared session cookie (fallback), so an app can migrate to
 * tokens one call site at a time without a synchronized flag day (#1069
 * Phase 1). See docs/security/cookie-isolation.md for the full rollout plan.
 *
 * The token path is tried first and, when it verifies, is authoritative —
 * its scopes are enforced via `requireScopes`. The cookie path is the
 * pre-existing, unscoped behavior, kept only for migration continuity: it
 * will stop working for a given caller once the session cookie is narrowed
 * to host-only (`SESSION_COOKIE_SCOPE=host`) and that caller's browser is no
 * longer sending it to this app's host — which is the point of adopting this
 * adapter ahead of that flip.
 */
export async function requireSessionOrAppToken(
  request: Request,
  options: SessionOrTokenAuthOptions
): Promise<SessionOrTokenAuthResult> {
  const bearer = request.headers.get('authorization');
  if (bearer?.startsWith('Bearer ')) {
    const verification = await verifyAppToken(bearer.slice(7), { aud: options.aud });
    if (verification) {
      const missing = options.requireScopes?.filter((s) => !verification.scopes.includes(s)) ?? [];
      if (missing.length > 0) {
        return { error: `Missing required scope(s): ${missing.join(', ')}`, status: 403 };
      }
      return { auth: { did: verification.sub, scopes: verification.scopes, via: 'token' } };
    }
    // Not a valid app token for this audience — fall through to the cookie
    // path rather than failing outright. Authorization: Bearer also carries
    // other credential types elsewhere in this codebase (e.g. legacy full
    // identity bearer tokens), so a failed app-token verification is not
    // proof the caller is unauthenticated.
  }

  const sessionToken = extractSessionCookie(request.headers.get('cookie'));
  if (!sessionToken) {
    return { error: 'Authorization: Bearer <app-token>, or a valid session cookie, is required', status: 401 };
  }

  const did = await validateLegacySessionCookie(sessionToken);
  if (!did) {
    return { error: 'Invalid or expired session', status: 401 };
  }

  return { auth: { did, scopes: [], via: 'cookie' } };
}
