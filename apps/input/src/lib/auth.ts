import { SESSION_COOKIE_NAME } from "@imajin/config";
import { NextRequest } from 'next/server';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export interface Identity {
  id: string;           // DID
  publicKey?: string;   // Ed25519 public key
  type: 'human' | 'agent' | 'presence';
  name?: string;
  handle?: string;
  tier?: 'soft' | 'hard';
}

export interface AuthResult {
  identity: Identity;
}

export interface AuthError {
  error: string;
  status: number;
}

export async function requireAuth(request: NextRequest): Promise<AuthResult | AuthError> {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return validateBearerToken(token);
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionCookie) {
    return validateSessionCookie(sessionCookie);
  }

  return { error: 'Missing authorization', status: 401 };
}

async function validateBearerToken(token: string): Promise<AuthResult | AuthError> {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      return { error: 'Invalid or expired token', status: 401 };
    }

    const data = await response.json();
    if (!data.valid || !data.identity) {
      return { error: 'Invalid token', status: 401 };
    }
    return { identity: data.identity };
  } catch (error) {
    console.error('Token validation failed:', error);
    return { error: 'Auth service unavailable', status: 503 };
  }
}

async function validateSessionCookie(jwt: string): Promise<AuthResult | AuthError> {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      method: 'GET',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${jwt}`,
      },
    });

    if (!response.ok) {
      return { error: 'Invalid or expired session', status: 401 };
    }

    const data = await response.json();
    return {
      identity: {
        id: data.did,
        type: data.type,
        name: data.name,
        handle: data.handle,
        tier: data.tier || 'hard',
      },
    };
  } catch (error) {
    console.error('Session validation failed:', error);
    return { error: 'Auth service unavailable', status: 503 };
  }
}

export async function optionalAuth(request: NextRequest): Promise<Identity | null> {
  const result = await requireAuth(request);
  if ('error' in result) return null;
  return result.identity;
}
