import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieOptions } from '@/lib/jwt';

/**
 * POST /api/logout
 * Clear the session cookie
 */
export async function POST(request: NextRequest) {
  const cookieConfig = getSessionCookieOptions(process.env.NODE_ENV === 'production');
  
  const response = NextResponse.json({ success: true });
  
  // Clear the cookie by setting it to empty with immediate expiration
  response.cookies.set(cookieConfig.name, '', {
    ...cookieConfig.options,
    maxAge: 0,
  });
  
  return response;
}
