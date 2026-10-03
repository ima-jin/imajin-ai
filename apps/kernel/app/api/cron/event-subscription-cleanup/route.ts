import { NextRequest, NextResponse } from 'next/server';
import { lt } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, eventSubscriptionLog } from '@/src/db';
import { EVENT_SUBSCRIPTION_RETENTION } from '@imajin/auth';
import { requireCronAuth } from '@/src/cron/auth';

const log = createLogger('kernel');

/**
 * This route mutates the database and must never be evaluated at build time.
 */
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/event-subscription-cleanup — purge event-subscription log
 * rows older than the retention window (#1884).
 *
 * Scheduled job (schedule: "0 1 * * *" — daily at 1am). Registered in
 * src/cron/schedule.ts. Protected by Authorization: Bearer {CRON_SECRET}, same
 * convention as /api/cron/attestation-cleanup.
 *
 * Retention is a modest window, not infinite replay (see
 * EVENT_SUBSCRIPTION_RETENTION in packages/auth/src/constants.ts) — an agent
 * absent longer than this needs a fresh grant-scoped read of current state,
 * not a full backlog. No bus events are emitted — deletion is a
 * garbage-collection operation, not a state transition.
 */
export async function GET(request: NextRequest) {
  // Fail closed (#2550): 503 when CRON_SECRET is unset, 401 on a wrong bearer.
  const denied = requireCronAuth(request);
  if (denied) return denied;

  try {
    const cutoff = new Date(Date.now() - EVENT_SUBSCRIPTION_RETENTION);

    const deleted = await db
      .delete(eventSubscriptionLog)
      .where(lt(eventSubscriptionLog.createdAt, cutoff))
      .returning({ id: eventSubscriptionLog.id });

    log.info({ deleted: deleted.length }, 'Event-subscription log cleanup sweep complete');

    return NextResponse.json({ ok: true, deleted: deleted.length });
  } catch (error) {
    log.error({ err: String(error) }, 'Event-subscription log cleanup sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
