import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { devices } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { corsHeaders } from '@imajin/config';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * DELETE /api/devices/[id]
 * Remove a device. Users can only remove their own devices.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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

    const result = await db
      .delete(devices)
      .where(and(eq(devices.id, params.id), eq(devices.did, session.sub)))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404, headers: cors });
    }

    return NextResponse.json({ deleted: true }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, '[devices/[id]] DELETE error');
    return NextResponse.json({ error: 'Failed to delete device' }, { status: 500, headers: cors });
  }
}
