import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { devices } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/devices
 * List known devices for the authenticated user.
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
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
    log.error({ err: String(error) }, '[devices] GET error');
    return NextResponse.json({ error: 'Failed to list devices' }, { status: 500, headers: cors });
  }
});
