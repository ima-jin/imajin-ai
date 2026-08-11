import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

export interface AppAuthContext {
  appDid: string;
  userDid: string;       // empty string for service tokens (no user delegation)
  scopes: string[];
  attestationId: string; // empty string for service tokens
  isServiceToken?: boolean; // true when minted via /auth/api/apps/token/service
}

export type AppAuthResult =
  | { appAuth: AppAuthContext }
  | {
      error: string;
      status: number;
      /**
       * True when a supplied `Authorization: Bearer` value was rejected
       * specifically because it doesn't verify as an app token at all (bad
       * signature/shape or expired) — as opposed to verifying as an app
       * token but failing some other check (e.g. missing scope). Session
       * JWTs are also sent as Authorization bearers (#1069), so callers
       * that want to fall back to session auth on a non-app-token bearer
       * must key off this flag rather than "a bearer was present" or
       * "requireAppAuth returned an error" (#1812).
       */
      notAppToken?: boolean;
    };

const getAuthUrl = () => process.env.AUTH_SERVICE_URL!;

/**
 * Verify a short-lived app token (#1069). Calls the kernel's stateless verify
 * endpoint, which checks the EdDSA signature + expiry locally (no DB hit) and
 * returns the AppAuthContext. The short TTL bounds the revocation window.
 *
 * Follow-up: move verification fully in-process (jose + published kernel public
 * key) to drop this round-trip entirely — tracked in #1069.
 */
async function verifyBearerAppToken(token: string, scope?: string): Promise<AppAuthResult> {
  const authUrl = getAuthUrl();
  if (!authUrl) {
    return { error: 'Auth service unavailable', status: 503 };
  }
  try {
    const res = await fetch(`${authUrl}/api/apps/token/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, scope }),
      cache: 'no-store',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // The verify endpoint returns 401 only when the token doesn't verify as
      // an app token at all (invalid signature/shape or expired); a 403 means
      // it verified fine but lacks the required scope. Only the former is a
      // "not an app token" signal for the caller's fallback decision.
      return { error: data.error ?? 'Invalid app token', status: res.status, notAppToken: res.status === 401 };
    }
    return { appAuth: (await res.json()) as AppAuthContext };
  } catch (err) {
    log.error({ err: String(err) }, '[APP-AUTH] Token verify request failed');
    return { error: 'Auth service unavailable', status: 503 };
  }
}

/**
 * Require app authentication via X-App-DID + X-App-Authorization headers.
 *
 * X-App-DID:           The app's DID (received at registration)
 * X-App-Authorization: The attestation ID from the user's consent flow
 *
 * Optionally supply `scope` to verify the approved scopes include a required scope.
 *
 * Works with both `Request` and `NextRequest`.
 */
export async function requireAppAuth(
  request: Request,
  options?: { scope?: string }
): Promise<AppAuthResult> {
  // Preferred path (#1069): short-lived scoped app token via Authorization: Bearer.
  const bearer = request.headers.get('authorization');
  if (bearer?.startsWith('Bearer ')) {
    return verifyBearerAppToken(bearer.slice(7), options?.scope);
  }

  // Legacy path: static attestationId as bearer. Kept during migration.
  const appDid = request.headers.get('x-app-did');
  const attestationId = request.headers.get('x-app-authorization');

  if (!appDid || !attestationId) {
    return { error: 'Authorization Bearer <app-token>, or X-App-DID + X-App-Authorization headers required', status: 401 };
  }

  const authUrl = getAuthUrl();
  if (!authUrl) {
    return { error: 'Auth service unavailable', status: 503 };
  }

  const internalApiKey = process.env.ATTESTATION_INTERNAL_API_KEY;
  if (!internalApiKey) {
    log.warn({}, '[APP-AUTH] ATTESTATION_INTERNAL_API_KEY not set');
    return { error: 'Auth service misconfigured', status: 503 };
  }

  try {
    // AUTH_SERVICE_URL already includes the `/auth` prefix (consistent with
    // require-auth.ts and session.ts which use `${authUrl}/api/...`)
    const res = await fetch(`${authUrl}/api/apps/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${internalApiKey}`,
      },
      body: JSON.stringify({ appDid, attestationId, scope: options?.scope }),
      cache: 'no-store',
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { error: data.error ?? 'Invalid app authorization', status: res.status };
    }

    const data = await res.json();
    return { appAuth: data as AppAuthContext };
  } catch (err) {
    log.error({ err: String(err) }, '[APP-AUTH] Validation request failed');
    return { error: 'Auth service unavailable', status: 503 };
  }
}
