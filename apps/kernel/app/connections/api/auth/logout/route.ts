import { withSessionCookie } from '@/src/lib/auth/session-cookie';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieOptions } from '@/src/lib/auth/jwt';

export function POST(_request: NextRequest) {
  const cookieConfig = getSessionCookieOptions();
  const response = NextResponse.json({ ok: true });

  return withSessionCookie(response, null, cookieConfig);
}
