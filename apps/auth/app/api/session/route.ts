import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { db } from '@/db';
import { identities } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * GET /api/session
 * Get the current session from cookie
 * 
 * Returns: {
 *   did: string,
 *   handle?: string,
 *   type: string,
 *   name?: string
 * }
 * 
 * Or 401 if not authenticated
 */
export async function GET(request: NextRequest) {
  try {
    const cookieConfig = getSessionCookieOptions(process.env.NODE_ENV === 'production');
    const token = request.cookies.get(cookieConfig.name)?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const session = await verifySessionToken(token);
    if (!session) {
      return NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401 }
      );
    }

    // Verify the identity actually exists in the database
    const identity = await db.select().from(identities).where(eq(identities.id, session.sub)).limit(1);
    if (identity.length === 0) {
      // JWT is valid but identity was deleted/reset — clear the stale cookie
      const response = NextResponse.json(
        { error: 'Identity not found' },
        { status: 401 }
      );
      response.cookies.delete(cookieConfig.name);
      return response;
    }

    return NextResponse.json({
      did: session.sub,
      handle: identity[0].handle || session.handle,
      type: identity[0].type || session.type,
      name: identity[0].name || session.name,
    });

  } catch (error) {
    console.error('Session error:', error);
    return NextResponse.json(
      { error: 'Failed to get session' },
      { status: 500 }
    );
  }
}
