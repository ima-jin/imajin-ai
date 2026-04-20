import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

export interface AppAuthContext {
  appDid: string;
  userDid: string;
  scopes: string[];
  attestationId: string;
}

export type AppAuthResult = { appAuth: AppAuthContext } | { error: string; status: number };

const getAuthUrl = () => process.env.AUTH_SERVICE_URL!;

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
  const appDid = request.headers.get('x-app-did');
  const attestationId = request.headers.get('x-app-authorization');

  if (!appDid || !attestationId) {
    return { error: 'X-App-DID and X-App-Authorization headers required', status: 401 };
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
    const res = await fetch(`${authUrl}/auth/api/apps/validate`, {
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
