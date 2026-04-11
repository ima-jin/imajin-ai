import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieOptions, verifySessionToken } from '@/src/lib/auth/jwt';
import { corsHeaders } from '@imajin/config';
import { createEmitter } from '@imajin/events';

const events = createEmitter('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const cookieConfig = getSessionCookieOptions();

  // Extract DID before clearing the session for the event
  const token = request.cookies.get(cookieConfig.name)?.value;
  const session = token ? await verifySessionToken(token) : null;

  const response = NextResponse.json({ success: true }, { headers: cors });

  response.cookies.set(cookieConfig.name, '', {
    ...cookieConfig.options,
    maxAge: 0,
  });

  events.emit({ action: 'session.destroy', did: session?.sub });

  return response;
}
