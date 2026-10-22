import { db, systemEvents } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';

/**
 * Metadata-only activity in the existing event ledger, never registry.apps.
 * Independent of optional application logging; cannot affect auth availability.
 */
export async function recordRegistryActivity(
  appDid: string, action: 'app.token.minted',
): Promise<void> {
  try {
    await db.insert(systemEvents).values({
      id: generateId('appactivity'), service: 'auth', action, did: appDid,
    });
  } catch {
    // Activity collection must not turn a successful mint into an auth outage.
  }
}
