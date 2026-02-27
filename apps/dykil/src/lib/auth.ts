/**
 * Auth utilities - validate sessions via cookie
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;
const COOKIE_NAME = 'imajin_session';

export interface Identity {
  id: string;
  type: string;
  name?: string;
  handle?: string;
  role?: string;
}

async function getSessionFromCookie(cookieHeader: string | null): Promise<Identity | null> {
  if (!cookieHeader) return null;

  const cookieList = cookieHeader.split(';').map(c => c.trim());
  const sessionCookie = cookieList.find(c => c.startsWith(`${COOKIE_NAME}=`));
  if (!sessionCookie) return null;

  const token = sessionCookie.split('=')[1];
  if (!token) return null;

  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}` },
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const session = await response.json();
    return {
      id: session.did,
      type: session.type,
      name: session.name,
      handle: session.handle,
      role: session.role,
    };
  } catch {
    return null;
  }
}

/**
 * Get session for server components
 */
export async function getSession(): Promise<Identity | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(COOKIE_NAME);
  if (!sessionCookie) return null;
  return getSessionFromCookie(`${COOKIE_NAME}=${sessionCookie.value}`);
}

/**
 * Require auth for API routes
 */
export async function requireAuth(request: NextRequest): Promise<{ identity: Identity } | { error: string; status: number }> {
  const identity = await getSessionFromCookie(request.headers.get('cookie'));
  if (!identity) {
    return { error: 'Not authenticated', status: 401 };
  }
  return { identity };
}
