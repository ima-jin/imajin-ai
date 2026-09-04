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
 * DELETE /api/devices/[id]
 * Revoke a device (#306). Revocation is a soft-delete: the row (and its
 * first_seen_at/last_seen_at history) is kept, only hidden from
 * GET /api/devices. Only the device's own DID may revoke it.
 */
export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cors = corsHeaders(request);

  try {
    const result = await resolveOwnedDevice(request, params.id, cors);
    if (isOwnedDeviceError(result)) {
      return result.errorResponse;
    }

    const [updated] = await db
      .update(devices)
      .set({ revoked: true })
      .where(eq(devices.id, params.id))
      .returning();

    return NextResponse.json({ revoked: true, device: updated }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, '[devices/[id]] DELETE error');
    return NextResponse.json({ error: 'Failed to revoke device' }, { status: 500, headers: cors });
  }
}
