import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { sweepInFlightWarpRuns } from '@/src/lib/warp/run-watch-sweep';

const log = createLogger('kernel');

/**
 * This route reads live DB and Warp API state per invocation and must never
 * be statically prerendered.
 */
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/warp-run-watch — fallback sweep for dispatched Warp runs
 * whose in-request watch never reported a terminal state or a BLOCKED
 * transition (#1838).
 *
 * Vercel Cron job (schedule: "*\/10 * * * *" — every 10 minutes). Registered
 * in vercel.json. Protected by Authorization: Bearer {CRON_SECRET}, same
 * convention as every other /api/cron/* route.
 *
 * See `apps/kernel/src/lib/warp/run-watch-sweep.ts` for why this exists (the
 * in-request watch is fire-and-forget background work in a serverless
 * invocation that has already sent its response, so it is not guaranteed to
 * run to completion), why a run-completion webhook was not the answer, and
 * why this sweep reuses the in-request watch's own publish functions rather
 * than duplicating them.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const outcome = await sweepInFlightWarpRuns();
    log.info({ ...outcome }, 'Warp run watch sweep complete');
    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    log.error({ err: String(error) }, 'Warp run watch sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
