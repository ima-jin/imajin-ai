/**
 * Cross-service session authentication for www
 *
 * Validates the imajin_session cookie by calling the auth service.
 * Falls back to Bearer token validation for API-to-API calls.
 */

import { NextRequest } from 'next/server';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const SESSION_COOKIE = 'imajin_session';

// Comma-separated list of DIDs that have admin access
const ADMIN_DIDS = (process.env.ADMIN_DID || '').split(',').map((d) => d.trim()).filter(Boolean);

export interface SessionIdentity {
  did: string;
  handle?: string | null;
  name?: string | null;
  email?: string | null;
  type?: string;
  tier?: string;
}

export interface AuthResult {
  authenticated: boolean;
  identity?: SessionIdentity;
  error?: string;
}

/**
 * Authenticate a request via session cookie or Bearer token.
 */
export async function authenticateRequest(request: NextRequest): Promise<AuthResult> {
  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (sessionCookie) {
    return validateSessionCookie(sessionCookie);
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return validateBearerToken(authHeader.slice(7));
  }

  return { authenticated: false, error: 'No credentials provided' };
}

async function validateSessionCookie(cookie: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    if (!res.ok) return { authenticated: false, error: 'Invalid session' };
    const data = await res.json();
    return {
      authenticated: true,
      identity: {
        did: data.did,
        handle: data.handle,
        name: data.name,
        email: data.email,
        type: data.type,
        tier: data.tier,
      },
    };
  } catch {
    return { authenticated: false, error: 'Auth service unavailable' };
  }
}

async function validateBearerToken(token: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return { authenticated: false, error: 'Invalid token' };
    const data = await res.json();
    if (!data.valid || !data.identity) return { authenticated: false, error: data.error || 'Invalid token' };
    return {
      authenticated: true,
      identity: {
        did: data.identity.id,
        name: data.identity.name,
        type: data.identity.type,
      },
    };
  } catch {
    return { authenticated: false, error: 'Auth service unavailable' };
  }
}

/**
 * Check if a DID has admin access.
 * Requires either tier === 'hard' (for general hard-DID check)
 * or membership in the ADMIN_DID env var list.
 */
export function isAdmin(identity: SessionIdentity): boolean {
  if (ADMIN_DIDS.length > 0) {
    return ADMIN_DIDS.includes(identity.did);
  }
  // Fall back to requiring a hard DID when no explicit list is set
  return identity.tier === 'hard';
}
