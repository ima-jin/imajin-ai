import { withSessionCookie } from '@/src/lib/auth/session-cookie';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieOptions, verifySessionToken } from '@/src/lib/auth/jwt';
import { corsHeaders } from '@imajin/config';
import { publish } from '@imajin/bus';

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const cookieConfig = getSessionCookieOptions();

  // Extract DID before clearing the session for the event
  const token = request.cookies.get(cookieConfig.name)?.value;
  const session = token ? await verifySessionToken(token) : null;

  const response = NextResponse.json({ success: true }, { headers: cors });


  if (session?.sub) {
    publish('session.destroyed', {
      issuer: session.sub,
      subject: session.sub,
      scope: 'kernel',
      payload: {},
    });
  }

  return withSessionCookie(response, null, cookieConfig);
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
