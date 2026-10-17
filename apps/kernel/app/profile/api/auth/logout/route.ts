import { NextRequest, NextResponse } from 'next/server';
import { withSessionCookie } from '@/src/lib/auth/session-cookie';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout - Clear the auth session cookie
 */
export function POST(_request: NextRequest) {
  const response = NextResponse.json({ success: true });
  return withSessionCookie(response, null);
}
