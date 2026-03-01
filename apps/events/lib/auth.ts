import { cookies } from 'next/headers';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;
const COOKIE_NAME = 'imajin_session';

export interface Session {
  did: string;
  handle?: string;
  type: string;
  name?: string;
}

/**
 * Get the current session from the auth service
 * Reads the shared cookie and validates with auth.imajin.ai
 */
export async function getSession(): Promise<Session | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    
    if (!token) {
      return null;
    }

    // Validate with auth service
    const response = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: {
        Cookie: `${COOKIE_NAME}=${token}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch (error) {
    console.error('Failed to get session:', error);
    return null;
  }
}

/**
 * Require authentication - throws redirect if not authenticated
 */
export async function requireAuth(): Promise<Session> {
  const session = await getSession();
  
  if (!session) {
    // In a real app, you'd redirect to login
    // For API routes, we return null and let the route handle it
    throw new Error('Authentication required');
  }
  
  return session;
}
