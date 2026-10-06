import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { count, and, gte, sql } from 'drizzle-orm';
import { db, notifications } from '@/src/db';

const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * How far back {@link countRecentWsPushMisses} looks. An hour is enough to spot
 * an ongoing incident (a flapping WS server, a batch of pushes landing while
 * the owner's socket was briefly down) without the count growing unbounded
 * between health checks.
 */
const WS_PUSH_MISS_WINDOW_MS = 60 * 60 * 1000;

/**
 * Count of recent notifications where the in-app channel was eligible (so a
 * live WS push was attempted, per `/notify/api/send`) but never reached a
 * socket — `channelsSent` carries `inapp` without `ws`. This is what makes an
 * otherwise-silent push miss (see `ws-push.ts`'s `pushNotificationToDid`)
 * visible on a health surface instead of only in per-instance logs.
 *
 * Never throws: a health check must degrade, not fail, when the DB read
 * itself has trouble — the field is simply omitted.
 */
async function countRecentWsPushMisses(): Promise<number | null> {
  try {
    const since = new Date(Date.now() - WS_PUSH_MISS_WINDOW_MS);
    const [row] = await db
      .select({ count: count() })
      .from(notifications)
      .where(
        and(
          gte(notifications.createdAt, since),
          sql`${notifications.channelsSent} @> ARRAY['inapp']::text[]`,
          sql`NOT (${notifications.channelsSent} @> ARRAY['ws']::text[])`,
        ),
      );
    return row?.count ?? 0;
  } catch (err) {
    log.warn({ err: String(err) }, 'notify health: could not count recent WS push misses');
    return null;
  }
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const recentWsPushMisses = await countRecentWsPushMisses();
  return NextResponse.json({
    ok: true,
    status: 'ok',
    service: 'notify',
    version: process.env.NEXT_PUBLIC_VERSION || '0.0.0',
    build: process.env.NEXT_PUBLIC_BUILD_HASH || 'dev',
    ...(recentWsPushMisses === null ? {} : { recentWsPushMisses }),
  }, { headers: cors });
}
