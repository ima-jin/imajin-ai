import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

import { SESSION_COOKIE_NAME } from '@imajin/config';
import { verifyAppToken } from './app-token';
import { resolveAppAudience } from './app-audience';

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
  /**
   * Group DID the caller is acting as (#2639 / #2644). Set ONLY on the `token`
   * path, from the verified act-as claim the kernel put on the token at mint
   * (user's group authority checked once there; operator approved act-as for
   * the app). Never set on the `cookie` path — that path ignores `x-acting-as`
   * as it always has. Feed it to `resolveActingDid`-style ownership
   * (`auth.actingAs ?? auth.did`).
   */
  actingAs?: string;
}

export type SessionOrTokenAuthResult =
  | { auth: SessionOrTokenAuth }
  | { error: string; status: number };

export interface SessionOrTokenAuthOptions {
  /**
   * This app's registry slug (e.g. `'dykil'`) — the default expected `aud` on
   * the token path (#2706). `IMAJIN_APP_AUD`, when set, overrides it. Never a
   * host: path-routed apps share one, so a host audience would let apps accept
   * each other's tokens. Required so a token minted for a different app can
   * never be replayed here.
   */
  slug: string;
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
async function validateLegacySessionCookie(
  token: string
): Promise<{ did: string; tier: string } | null> {
  const authUrl = getAuthUrl();
  if (!authUrl) return null;
  try {
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const did = data.did ?? data.identity?.did ?? null;
    if (!did) return null;
    // Same fallback `require-auth.ts` applies: no tier reported means soft.
    return { did, tier: data.tier || data.identity?.tier || 'soft' };
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
  const result = await authenticateSessionOrAppToken(request, options);
  return 'auth' in result ? { auth: result.auth } : result;
}

/**
 * Same authentication as {@link requireSessionOrAppToken}, but additionally
 * surfaces the identity tier the kernel session reported on the `cookie`
 * path (`sessionTier`). The token path carries no tier claim by design —
 * tier is looked up per DID instead, so an upgrade needs no token re-mint.
 * Internal: consumed by `requireHardDIDOrAppToken`, not exported from the
 * package root.
 */
export async function authenticateSessionOrAppToken(
  request: Request,
  options: SessionOrTokenAuthOptions
): Promise<{ auth: SessionOrTokenAuth; sessionTier?: string } | { error: string; status: number }> {
  const bearer = request.headers.get('authorization');
  if (bearer?.startsWith('Bearer ')) {
    let aud: string;
    try {
      aud = resolveAppAudience(options.slug);
    } catch (err) {
      log.error({ err: String(err) }, '[AUTH] App audience misconfigured');
      return { error: 'App audience is misconfigured', status: 500 };
    }
    const verification = await verifyAppToken(bearer.slice(7), { aud });
    if (!verification) {
      // A Bearer that does not verify for THIS app's audience is a hard 401 —
      // it never degrades to the cookie path (#2706). Falling through hid a
      // wrong/host audience behind a working browser session while every
      // Bearer client got an opaque 401.
      return { error: 'Invalid or expired app token for this app', status: 401 };
    }
    const missing = options.requireScopes?.filter((s) => !verification.scopes.includes(s)) ?? [];
    if (missing.length > 0) {
      return { error: `Missing required scope(s): ${missing.join(', ')}`, status: 403 };
    }
    return {
      auth: {
        did: verification.sub,
        scopes: verification.scopes,
        via: 'token',
        ...(verification.actingAs ? { actingAs: verification.actingAs } : {}),
      },
    };
  }

  const sessionToken = extractSessionCookie(request.headers.get('cookie'));
  if (!sessionToken) {
    return { error: 'Authorization: Bearer <app-token>, or a valid session cookie, is required', status: 401 };
  }

  const session = await validateLegacySessionCookie(sessionToken);
  if (!session) {
    return { error: 'Invalid or expired session', status: 401 };
  }

  return { auth: { did: session.did, scopes: [], via: 'cookie' }, sessionTier: session.tier };
}
