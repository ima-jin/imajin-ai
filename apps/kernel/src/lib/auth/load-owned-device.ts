/**
 * Shared auth + ownership preamble for the per-device routes (#306).
 *
 * `DELETE /auth/api/devices/[id]` and `POST /auth/api/devices/[id]/trust`
 * both start the same way: `requireAuth()`, look up the device row, 404 if
 * it doesn't exist, 403 if it belongs to a different DID. Factored out once
 * rather than repeated across both route files — mirrors the
 * `resolveCallerIdentity` / `isCallerIdentityError` pattern in
 * `require-caller-did.ts` (#1933).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db, devices, type Device } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth, unauthorizedResponse } from './middleware';
import type { SessionPayload } from './jwt';

export interface OwnedDevice {
  session: SessionPayload;
  device: Device;
}

export interface OwnedDeviceError {
  errorResponse: NextResponse;
}

/**
 * Resolve the authenticated caller and the device they're acting on, or a
 * ready-to-return error response (401 unauthenticated, 404 unknown device,
 * 403 device owned by a different DID).
 */
export async function resolveOwnedDevice(
  request: NextRequest,
  deviceId: string,
  cors: HeadersInit,
): Promise<OwnedDevice | OwnedDeviceError> {
  const session = await requireAuth(request);
  if (!session) {
    return { errorResponse: unauthorizedResponse() };
  }

  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) {
    return { errorResponse: NextResponse.json({ error: 'Device not found' }, { status: 404, headers: cors }) };
  }
  if (device.did !== session.sub) {
    return {
      errorResponse: NextResponse.json({ error: 'Not authorized to modify this device' }, { status: 403, headers: cors }),
    };
  }

  return { session, device };
}

export function isOwnedDeviceError(result: OwnedDevice | OwnedDeviceError): result is OwnedDeviceError {
  return 'errorResponse' in result;
}
