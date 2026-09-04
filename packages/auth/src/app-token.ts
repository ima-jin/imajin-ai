import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

const getAuthUrl = () => process.env.AUTH_SERVICE_URL!;

export interface AppTokenVerification {
  /** The user DID this token was minted for. */
  sub: string;
  /** The app host this token is scoped to. */
  aud: string;
  /** Granted scopes, as requested at mint time (see POST {kernel}/auth/api/tokens/app). */
  scopes: string[];
}

/**
 * Verify a session-scoped app token (#1069 Phase 1), minted by
 * `POST {kernel}/auth/api/tokens/app` from a caller's first-party session.
 *
 * Calls the kernel's stateless verify endpoint — the EdDSA signature,
 * expiry, and token type are checked there, locally, with no DB hit. When
 * `options.aud` is supplied, pass your own app's host: the kernel enforces
 * that the token's `aud` claim matches it exactly, so a token minted for a
 * different app can never verify here.
 *
 * Returns null on any failure (invalid/expired/wrong-audience token, or the
 * auth service being unreachable) — callers should treat null
 * the same as "not authenticated via this path" and fall back accordingly
 * (see `requireSessionOrAppToken`).
 */
export async function verifyAppToken(
  token: string,
  options?: { aud?: string }
): Promise<AppTokenVerification | null> {
  const authUrl = getAuthUrl();
  if (!authUrl) {
    log.warn({}, '[APP-TOKEN] AUTH_SERVICE_URL not set');
    return null;
  }
  try {
    const res = await fetch(`${authUrl}/api/tokens/app/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, aud: options?.aud }),
      cache: 'no-store',
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.sub || !data.aud) return null;
    return {
      sub: data.sub,
      aud: data.aud,
      scopes: Array.isArray(data.scopes) ? data.scopes : [],
    };
  } catch (err) {
    log.error({ err: String(err) }, '[APP-TOKEN] Verify request failed');
    return null;
  }
}
