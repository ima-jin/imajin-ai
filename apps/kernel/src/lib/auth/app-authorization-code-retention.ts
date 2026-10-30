import { lt, sql } from 'drizzle-orm';
import { db, appAuthorizationCodes } from '@/src/db';

export const APP_AUTHORIZATION_CODE_GRACE_MS = 60 * 60 * 1000;

/**
 * The #3161 delete exception covers only these short-lived bearer records.
 * Consumed codes get grace from consumption; otherwise grace starts at expiry.
 * Keep this expression aligned with the retention index migration.
 */
export async function sweepAppAuthorizationCodes(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - APP_AUTHORIZATION_CODE_GRACE_MS);
  const deleted = await db.delete(appAuthorizationCodes)
    .where(lt(
      sql`coalesce(${appAuthorizationCodes.consumedAt}, ${appAuthorizationCodes.expiresAt})`,
      sql`${cutoff.toISOString()}::timestamptz`,
    ))
    .returning({ removed: sql<number>`1` });
  return deleted.length;
}
