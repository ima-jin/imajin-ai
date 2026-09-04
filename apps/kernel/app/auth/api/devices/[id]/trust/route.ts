import { NextRequest, NextResponse } from 'next/server';
import { db, devices } from '@/src/db';
import { eq } from 'drizzle-orm';
import { resolveOwnedDevice, isOwnedDeviceError } from '@/src/lib/auth/load-owned-device';
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
    const result = await resolveOwnedDevice(request, params.id, cors);
    if (isOwnedDeviceError(result)) {
      return result.errorResponse;
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
