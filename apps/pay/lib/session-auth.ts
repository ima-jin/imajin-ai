/**
 * Cross-service session authentication
 * 
 * Validates the imajin_session cookie by calling auth service.
 * Use this in any service that needs to know who the user is.
 * 
 * Falls back to Bearer token validation for API-to-API calls.
 */

import { NextRequest } from 'next/server';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
import { SESSION_COOKIE_NAME as SESSION_COOKIE } from '@imajin/config';

export interface SessionIdentity {
  did: string;
  handle?: string | null;
  name?: string | null;
  type?: string;
  role?: string;
  tier?: string;
}

export interface AuthResult {
  authenticated: boolean;
  identity?: SessionIdentity;
  error?: string;
}

/**
 * Authenticate a request via session cookie or Bearer token.
 * 
 * 1. Checks for imajin_session cookie → validates with auth/api/session
 * 2. Falls back to Bearer token → validates with auth/api/validate
 * 3. Returns { authenticated: false } if neither present
 */
export async function authenticateRequest(request: NextRequest): Promise<AuthResult> {
  // Try session cookie first
  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (sessionCookie) {
    return validateSessionCookie(sessionCookie);
  }

  // Fall back to Bearer token
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return validateBearerToken(authHeader.slice(7));
  }

  return { authenticated: false, error: 'No credentials provided' };
}

/**
 * Validate session cookie by calling auth service
 */
async function validateSessionCookie(cookie: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: {
        'Cookie': `${SESSION_COOKIE}=${cookie}`,
      },
    });

    if (!res.ok) {
      return { authenticated: false, error: 'Invalid session' };
    }

    const data = await res.json();
    return {
      authenticated: true,
      identity: {
        did: data.did,
        handle: data.handle,
        name: data.name,
        type: data.type,
        role: data.role,
        tier: data.tier,
      },
    };
  } catch (error) {
    console.warn('Auth service unreachable for session validation:', error);
    return { authenticated: false, error: 'Auth service unavailable' };
  }
}

/**
 * Validate Bearer token via auth service (for API-to-API calls)
 */
async function validateBearerToken(token: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!res.ok) {
      return { authenticated: false, error: 'Invalid token' };
    }

    const data = await res.json();
    if (!data.valid || !data.identity) {
      return { authenticated: false, error: data.error || 'Invalid token' };
    }

    return {
      authenticated: true,
      identity: {
        did: data.identity.id,
        name: data.identity.name,
        type: data.identity.type,
      },
    };
  } catch (error) {
    console.warn('Auth service unreachable for token validation:', error);
    return { authenticated: false, error: 'Auth service unavailable' };
  }
}
