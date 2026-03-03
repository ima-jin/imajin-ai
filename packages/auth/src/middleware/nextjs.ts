/**
 * Next.js middleware helpers for authentication and authorization
 *
 * These helpers validate sessions and enforce permission requirements
 * based on identity tiers and trust graph membership.
 */

import { NextRequest, NextResponse } from 'next/server';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;

export interface AuthSession {
  did: string;
  handle?: string;
  type: string;
  name?: string;
  tier: 'soft' | 'hard';
}

export interface AuthResult {
  session: AuthSession;
}

export interface AuthError {
  error: string;
  status: number;
}

/**
 * Validate session with auth service
 */
async function validateSession(request: NextRequest): Promise<AuthSession | null> {
  if (!AUTH_SERVICE_URL) {
    console.error('AUTH_SERVICE_URL is not configured');
    return null;
  }

  try {
    const sessionCookie = request.cookies.get('imajin_session')?.value;
    if (!sessionCookie) {
      return null;
    }

    const response = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      method: 'GET',
      headers: {
        Cookie: `imajin_session=${sessionCookie}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return {
      did: data.did,
      handle: data.handle,
      type: data.type,
      name: data.name,
      tier: data.tier || 'hard', // default to hard for backward compatibility
    };
  } catch (error) {
    console.error('Session validation failed:', error);
    return null;
  }
}

/**
 * Check if a DID is in the trust graph (has at least one connection)
 */
async function isInGraph(did: string): Promise<boolean> {
  const connectionsUrl = process.env.CONNECTIONS_SERVICE_URL || 'https://connections.imajin.ai';

  try {
    const response = await fetch(`${connectionsUrl}/api/connections/status/${encodeURIComponent(did)}`);
    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return data.inGraph === true;
  } catch (error) {
    console.error('Failed to check graph membership:', error);
    return false;
  }
}

/**
 * Require authentication (any tier: soft or hard DID)
 *
 * Usage:
 * ```ts
 * const auth = await requireAuth(request);
 * if ('error' in auth) {
 *   return NextResponse.json({ error: auth.error }, { status: auth.status });
 * }
 * const { session } = auth;
 * ```
 */
export async function requireAuth(request: NextRequest): Promise<AuthResult | AuthError> {
  const session = await validateSession(request);

  if (!session) {
    return { error: 'Authentication required', status: 401 };
  }

  return { session };
}

/**
 * Require hard DID authentication (keypair-based identity)
 *
 * Usage:
 * ```ts
 * const auth = await requireHardDID(request);
 * if ('error' in auth) {
 *   return NextResponse.json({ error: auth.error }, { status: auth.status });
 * }
 * const { session } = auth;
 * ```
 */
export async function requireHardDID(request: NextRequest): Promise<AuthResult | AuthError> {
  const session = await validateSession(request);

  if (!session) {
    return { error: 'Authentication required', status: 401 };
  }

  if (session.tier === 'soft') {
    return {
      error: 'This action requires a full identity (hard DID)',
      status: 403,
    };
  }

  return { session };
}

/**
 * Require graph membership (hard DID + at least one connection)
 *
 * Usage:
 * ```ts
 * const auth = await requireGraphMember(request);
 * if ('error' in auth) {
 *   return NextResponse.json({ error: auth.error }, { status: auth.status });
 * }
 * const { session } = auth;
 * ```
 */
export async function requireGraphMember(request: NextRequest): Promise<AuthResult | AuthError> {
  const session = await validateSession(request);

  if (!session) {
    return { error: 'Authentication required', status: 401 };
  }

  if (session.tier === 'soft') {
    return {
      error: 'This action requires a full identity (hard DID)',
      status: 403,
    };
  }

  const inGraph = await isInGraph(session.did);
  if (!inGraph) {
    return {
      error: 'This action requires at least one connection in the trust graph',
      status: 403,
    };
  }

  return { session };
}

/**
 * Helper to create error responses
 */
export function errorResponse(message: string, status: number = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
