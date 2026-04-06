import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieOptions } from '@/src/lib/auth/jwt';

export async function POST(_request: NextRequest) {
  const cookieConfig = getSessionCookieOptions();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(cookieConfig.name, '', {
    ...cookieConfig.options,
    maxAge: 0,
  });
  return response;
}
