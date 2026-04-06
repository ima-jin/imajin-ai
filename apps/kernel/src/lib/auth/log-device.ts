import { createHash } from 'crypto';
import { db } from '@/src/db';
import { devices } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

/**
 * Derive a stable device fingerprint from IP + User-Agent.
 * Non-cryptographic — just a stable identifier, not a security boundary.
 */
export function deviceFingerprint(ip: string | null, userAgent: string | null): string {
  return createHash('sha256')
    .update(`${ip ?? ''}:${userAgent ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Record or refresh a device entry for the given DID.
 * Non-fatal — caller must wrap in try/catch if needed.
 */
export async function logDevice(params: {
  did: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  const { did, ip, userAgent } = params;
  const fingerprint = deviceFingerprint(ip, userAgent);
  const now = new Date();

  // Upsert: insert if new, update lastSeenAt if already known
  const existing = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.did, did), eq(devices.fingerprint, fingerprint)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(devices)
      .set({ lastSeenAt: now, ip, userAgent })
      .where(eq(devices.id, existing[0].id));
  } else {
    await db.insert(devices).values({
      id: `dev_${nanoid(16)}`,
      did,
      fingerprint,
      ip,
      userAgent,
      firstSeenAt: now,
      lastSeenAt: now,
      trusted: false,
    });
  }
}
