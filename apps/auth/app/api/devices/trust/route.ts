import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { devices } from '@/src/db/schema';
import { eq, and } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/devices/trust
 * Mark a device as trusted.
 *
 * Body: { deviceId: string }
 */
export async function POST(request: NextRequest) {
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

    const body = await request.json();
    const { deviceId } = body;
    if (!deviceId) {
      return NextResponse.json({ error: 'deviceId required' }, { status: 400, headers: cors });
    }

    const result = await db
      .update(devices)
      .set({ trusted: true })
      .where(and(eq(devices.id, deviceId), eq(devices.did, session.sub)))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404, headers: cors });
    }

    return NextResponse.json({ device: result[0] }, { headers: cors });

  } catch (error) {
    console.error('[devices/trust] POST error:', error);
    return NextResponse.json({ error: 'Failed to trust device' }, { status: 500, headers: cors });
  }
}
