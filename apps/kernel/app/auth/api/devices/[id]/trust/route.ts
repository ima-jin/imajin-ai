import { NextRequest, NextResponse } from 'next/server';
import { db, devices } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth, unauthorizedResponse } from '@/src/lib/auth/middleware';
import { corsHeaders } from '@imajin/config';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/devices/[id]/trust
 * Mark a device as trusted (#306). Only the device's own DID may trust it.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cors = corsHeaders(request);

  try {
    const session = await requireAuth(request);
    if (!session) {
      return unauthorizedResponse();
    }

    const [device] = await db.select().from(devices).where(eq(devices.id, params.id)).limit(1);
    if (!device) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404, headers: cors });
    }
    if (device.did !== session.sub) {
      return NextResponse.json({ error: 'Not authorized to modify this device' }, { status: 403, headers: cors });
    }

    const [updated] = await db
      .update(devices)
      .set({ trusted: true })
      .where(eq(devices.id, params.id))
      .returning();

    return NextResponse.json({ device: updated }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, '[devices/[id]/trust] POST error');
    return NextResponse.json({ error: 'Failed to trust device' }, { status: 500, headers: cors });
  }
}
