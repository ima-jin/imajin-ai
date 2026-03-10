import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from '@imajin/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout - Clear the auth session cookie
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.json({ success: true });

  const isProduction = process.env.NODE_ENV === 'production';

  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    domain: isProduction ? '.imajin.ai' : undefined,
    maxAge: 0, // Expire immediately
  });

  return response;
}
