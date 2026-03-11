import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { db } from '@/src/db';
import { identities } from '@/src/db/schema';
import { eq, sql } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}


export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const cookieConfig = getSessionCookieOptions();
    const token = request.cookies.get(cookieConfig.name)?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401, headers: cors }
      );
    }

    const session = await verifySessionToken(token);
    if (!session) {
      const response = NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401, headers: cors }
      );
      response.cookies.delete(cookieConfig.name);
      return response;
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

    // Check profile tier as source of truth (profile DB shares same Postgres)
    let profileTier = session.tier || 'hard';
    try {
      const profileRows = await db.execute(
        sql`SELECT identity_tier FROM profile.profiles WHERE did = ${session.sub} LIMIT 1`
      );
      const row = (profileRows as any)?.[0];
      if (row?.identity_tier) profileTier = row.identity_tier;
    } catch {
      // Profile schema may not be available
    }

    return NextResponse.json({
      did: session.sub,
      handle: identity[0].handle || session.handle,
      type: identity[0].type || session.type,
      name: identity[0].name || session.name,
      role: metadata.role || 'member',
      tier: profileTier,
    }, { headers: cors });

  } catch (error) {
    console.error('Session error:', error);
    return NextResponse.json(
      { error: 'Failed to get session' },
      { status: 500, headers: cors }
    );
  }
}
