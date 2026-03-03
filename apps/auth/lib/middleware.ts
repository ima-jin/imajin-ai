import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, getSessionCookieOptions, SessionPayload } from './jwt';

/**
 * Middleware helper to require authentication (soft or hard DID)
 *
 * Usage:
 * const session = await requireAuth(request);
 * if (!session) {
 *   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 * }
 */
export async function requireAuth(request: NextRequest): Promise<SessionPayload | null> {
  const cookieConfig = getSessionCookieOptions(process.env.NODE_ENV === 'production');
  const token = request.cookies.get(cookieConfig.name)?.value;

  if (!token) {
    return null;
  }

  const session = await verifySessionToken(token);
  if (!session) {
    return null;
  }

  return session;
}

/**
 * Middleware helper to require hard DID authentication (keypair-based)
 *
 * Usage:
 * const session = await requireHardDID(request);
 * if (!session) {
 *   return NextResponse.json({ error: 'Hard DID required' }, { status: 403 });
 * }
 */
export async function requireHardDID(request: NextRequest): Promise<SessionPayload | null> {
  const session = await requireAuth(request);

  if (!session) {
    return null;
  }

  // Check if this is a hard DID
  if (session.tier === 'soft') {
    return null;
  }

  return session;
}

/**
 * Helper to create a JSON response with authentication error
 */
export function unauthorizedResponse(message = 'Authentication required') {
  return NextResponse.json({ error: message }, { status: 401 });
}

/**
 * Helper to create a JSON response with hard DID requirement error
 */
export function hardDIDRequiredResponse(message = 'This action requires a full identity (hard DID)') {
  return NextResponse.json({
    error: message,
    upgradeRequired: true,
  }, { status: 403 });
}
