import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';

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

    return NextResponse.json({
      did: session.sub,
      handle: session.handle,
      type: session.type,
      name: session.name,
    });

  } catch (error) {
    console.error('Session error:', error);
    return NextResponse.json(
      { error: 'Failed to get session' },
      { status: 500 }
    );
  }
}
