import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const cookieConfig = getSessionCookieOptions();
  
  const response = NextResponse.json({ success: true }, { headers: cors });
  
  response.cookies.set(cookieConfig.name, '', {
    ...cookieConfig.options,
    maxAge: 0,
  });
  
  return response;
}
