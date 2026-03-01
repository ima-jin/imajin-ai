import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { db } from '@/src/db';
import { identities } from '@/src/db/schema';
import { eq } from 'drizzle-orm';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '';
  // Allow any *.imajin.ai subdomain
  const allowed = origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const cookieConfig = getSessionCookieOptions(process.env.NODE_ENV === 'production');
    const token = request.cookies.get(cookieConfig.name)?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401, headers: cors }
      );
    }

    const session = await verifySessionToken(token);
    if (!session) {
      return NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401, headers: cors }
      );
    }

    const identity = await db.select().from(identities).where(eq(identities.id, session.sub)).limit(1);
    if (identity.length === 0) {
      const response = NextResponse.json(
        { error: 'Identity not found' },
        { status: 401, headers: cors }
      );
      response.cookies.delete(cookieConfig.name);
      return response;
    }

    const metadata = identity[0].metadata as Record<string, unknown> || {};
    return NextResponse.json({
      did: session.sub,
      handle: identity[0].handle || session.handle,
      type: identity[0].type || session.type,
      name: identity[0].name || session.name,
      role: metadata.role || 'member',
    }, { headers: cors });

  } catch (error) {
    console.error('Session error:', error);
    return NextResponse.json(
      { error: 'Failed to get session' },
      { status: 500, headers: cors }
    );
  }
}
