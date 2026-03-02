/**
 * Auth utilities - validate sessions via cookie or Bearer token
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;
const COOKIE_NAME = 'imajin_session';

export interface Identity {
  id: string;
  type: string;
  name?: string;
  handle?: string;
  tier?: 'soft' | 'hard';
}

/**
 * Get session from cookie by calling auth service
 */
export async function getSessionFromCookie(cookieHeader: string | null): Promise<Identity | null> {
  if (!cookieHeader) return null;
  
  // Extract session cookie
  const cookies = cookieHeader.split(';').map(c => c.trim());
  const sessionCookie = cookies.find(c => c.startsWith(`${COOKIE_NAME}=`));
  if (!sessionCookie) return null;
  
  const token = sessionCookie.split('=')[1];
  if (!token) return null;

  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: {
        Cookie: `${COOKIE_NAME}=${token}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) return null;
    
    const session = await response.json();
    return {
      id: session.did,
      type: session.type,
      name: session.name,
      handle: session.handle,
      tier: session.tier || 'hard',
    };
  } catch (error) {
    console.error('Session validation failed:', error);
    return null;
  }
}

/**
 * Validate Bearer token (legacy)
 */
export async function validateToken(token: string): Promise<{ valid: boolean; identity?: Identity }> {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) return { valid: false };
    return response.json();
  } catch (error) {
    console.error('Token validation failed:', error);
    return { valid: false };
  }
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

/**
 * Require auth - checks cookie first, then Bearer token
 */
export async function requireAuth(request: Request): Promise<{ identity: Identity } | { error: string; status: number }> {
  // Try cookie first (cross-subdomain session)
  const cookieHeader = request.headers.get('Cookie');
  const sessionIdentity = await getSessionFromCookie(cookieHeader);
  if (sessionIdentity) {
    return { identity: sessionIdentity };
  }

  // Fall back to Bearer token
  const token = extractToken(request);
  if (!token) {
    return { error: 'Not authenticated', status: 401 };
  }

  const result = await validateToken(token);
  if (!result.valid || !result.identity) {
    return { error: 'Invalid or expired token', status: 401 };
  }

  return { identity: result.identity };
}

/**
 * Get session for server components (convenience wrapper)
 */
export async function getSession(): Promise<Identity | null> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(COOKIE_NAME);

  if (!sessionCookie) return null;

  const cookieHeader = `${COOKIE_NAME}=${sessionCookie.value}`;
  return getSessionFromCookie(cookieHeader);
}

/**
 * Require hard DID authentication (keypair-based identity)
 */
export async function requireHardDID(request: Request): Promise<{ identity: Identity } | { error: string; status: number }> {
  const authResult = await requireAuth(request);

  if ('error' in authResult) {
    return authResult;
  }

  const { identity } = authResult;

  // Check if this is a hard DID
  if (identity.tier === 'soft') {
    return {
      error: 'This action requires a full identity (hard DID)',
      status: 403,
    };
  }

  return { identity };
}
