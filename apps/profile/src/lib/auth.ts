/**
 * Auth utilities - validate session cookies against auth service
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export interface Identity {
  id: string;
  type: 'human' | 'agent' | 'presence';
  name?: string;
  handle?: string;
  tier?: 'soft' | 'hard';
}

/**
 * Validate session by forwarding the imajin_session cookie to auth service.
 * Falls back to Bearer token if no cookie present.
 */
export async function requireAuth(request: Request): Promise<{ identity: Identity } | { error: string; status: number }> {
  // Try session cookie first (how the browser authenticates)
  const cookieHeader = request.headers.get('cookie') || '';
  const sessionMatch = cookieHeader.match(/imajin_session=([^;]+)/);

  if (sessionMatch) {
    try {
      const response = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
        headers: { Cookie: `imajin_session=${sessionMatch[1]}` },
      });

      if (response.ok) {
        const data = await response.json();
        const identity: Identity = {
          id: data.did || data.identity?.did || data.identity?.id,
          type: data.type || data.identity?.type || 'human',
          name: data.name || data.identity?.name,
          handle: data.handle || data.identity?.handle,
          tier: data.tier || data.identity?.tier || 'hard',
        };
        if (identity.id) return { identity };
      }
    } catch (error) {
      console.error('[AUTH] Session validation failed:', error);
    }
  }

  // Fallback: Bearer token in Authorization header
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const response = await fetch(`${AUTH_SERVICE_URL}/api/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.valid && data.identity) {
          return { identity: data.identity };
        }
      }
    } catch (error) {
      console.error('[AUTH] Token validation failed:', error);
    }
  }

  return { error: 'Missing or invalid authentication', status: 401 };
}
