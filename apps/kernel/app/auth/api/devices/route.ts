import { NextRequest, NextResponse } from 'next/server';
import { db, devices } from '@/src/db';
import { and, eq, desc } from 'drizzle-orm';
import { requireAuth, unauthorizedResponse } from '@/src/lib/auth/middleware';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/devices
 * List known, non-revoked devices for the authenticated user (#306).
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const session = await requireAuth(request);
    if (!session) {
      return unauthorizedResponse();
    }

    const rows = await db
      .select()
      .from(devices)
      .where(and(eq(devices.did, session.sub), eq(devices.revoked, false)))
      .orderBy(desc(devices.lastSeenAt));

    return NextResponse.json({ devices: rows }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, '[devices] GET error');
    return NextResponse.json({ error: 'Failed to list devices' }, { status: 500, headers: cors });
  }
});
