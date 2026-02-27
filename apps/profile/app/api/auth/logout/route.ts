import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout - Clear the auth session cookie
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.json({ success: true });

  // Clear the imajin_session cookie
  // Use the same domain setting as production for consistency
  const isProduction = process.env.NODE_ENV === 'production';

  response.cookies.set('imajin_session', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    domain: isProduction ? '.imajin.ai' : undefined,
    maxAge: 0, // Expire immediately
  });

  return response;
}
