import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieOptions } from '@/lib/jwt';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '';
  const allowed = origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const cookieConfig = getSessionCookieOptions(process.env.NODE_ENV === 'production');
  
  const response = NextResponse.json({ success: true }, { headers: cors });
  
  response.cookies.set(cookieConfig.name, '', {
    ...cookieConfig.options,
    maxAge: 0,
  });
  
  return response;
}
