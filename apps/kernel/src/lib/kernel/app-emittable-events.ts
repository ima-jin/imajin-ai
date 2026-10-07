/**
 * The operator-approved list of event types a registered app may emit
 * (#2638 / #2641) — `registry.apps.emittable_events`: the DB lookup.
 * Validation lives in `emittable-events.ts` (pure).
 *
 * Same ceiling pattern as approved scopes: the app (or its manifest) *declares*,
 * an operator *approves* on an operator-only path, and nothing beyond the
 * approved list is ever honoured. Default for every app: nothing.
 *
 * What an approved event type can DO is bounded separately and not widenable
 * from here: an app-emitted event only ever runs the notify and audit-log
 * reactors (`publishAppEvent` in @imajin/bus). The list decides *which* types
 * an app may send, never what they trigger.
 */
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { readEmittableEvents } from '@/src/lib/kernel/emittable-events';

const log = createLogger('kernel');

/**
 * The emit allowlist for an active app, or `null` when `appDid` isn't an active
 * (non-revoked) registered app — a revoked app loses the ability to emit
 * immediately, independent of its token's TTL.
 */
export async function resolveEmittableEvents(appDid: string): Promise<string[] | null> {
  try {
    const [row] = await db
      .select({ status: registryApps.status, emittableEvents: registryApps.emittableEvents })
      .from(registryApps)
      .where(eq(registryApps.appDid, appDid))
      .limit(1);
    if (row?.status !== 'active') return null;
    return readEmittableEvents(row.emittableEvents);
  } catch (err) {
    log.error({ err: String(err), appDid }, 'resolveEmittableEvents: lookup failed');
    return null;
  }
}
