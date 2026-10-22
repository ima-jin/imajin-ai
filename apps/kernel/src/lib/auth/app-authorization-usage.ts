import { sql } from 'drizzle-orm';
import { db, appAuthorizationUsage } from '@/src/db';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * Best-effort evidence after successful authorization only. Callers do not await
 * this write: telemetry must never delay or fail an auth response. The atomic
 * conflict guard throttles mutations across workers, not just within a process.
 */
export async function recordAppAuthorizationUse(attestationId: string): Promise<void> {
  try {
    await db.insert(appAuthorizationUsage).values({
      attestationId,
      lastUsedAt: new Date(),
    }).onConflictDoUpdate({
      target: appAuthorizationUsage.attestationId,
      set: {
        lastUsedAt: sql`clock_timestamp()`,
        useCount: sql`${appAuthorizationUsage.useCount} + 1`,
      },
      setWhere: sql`${appAuthorizationUsage.lastUsedAt} <= clock_timestamp() - interval '1 minute'`,
    });
  } catch {
    // No token, request body, grant identifier or database error in telemetry logs.
    log.warn({}, 'app authorization usage recording unavailable');
  }
}
