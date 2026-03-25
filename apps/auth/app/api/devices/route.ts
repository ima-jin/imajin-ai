import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { devices } from '@/src/db/schema';
import { eq, desc } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/devices
 * List known devices for the authenticated user.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const cookieConfig = getSessionCookieOptions();
    const token = request.cookies.get(cookieConfig.name)?.value;
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
    }
    const session = await verifySessionToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401, headers: cors });
    }

    const rows = await db
      .select()
      .from(devices)
      .where(eq(devices.did, session.sub))
      .orderBy(desc(devices.lastSeenAt));

    return NextResponse.json({ devices: rows }, { headers: cors });

  } catch (error) {
    console.error('[devices] GET error:', error);
    return NextResponse.json({ error: 'Failed to list devices' }, { status: 500, headers: cors });
  }
}
