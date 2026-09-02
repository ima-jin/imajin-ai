import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { runUsageRollup, previousUtcDayWindow } from '@/src/lib/usage/rollup';

const log = createLogger('kernel');

/**
 * This route mutates the database (indirectly, via bus-published
 * attestations) and must never be evaluated at build time. See
 * vault-grant-expiry's route for the full rationale.
 */
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/usage-rollup — daily clock-rollup over `usage.incurred` (#1148).
 *
 * Vercel Cron job (schedule: "0 2 * * *" — 02:00 UTC daily, after the
 * previous UTC day's `usage.incurred` rows have all landed). Registered in
 * vercel.json. Protected by Authorization: Bearer {CRON_SECRET}, same
 * convention as every other cron route.
 *
 * Reads the previous full UTC day, groups by (principal_did, resource,
 * source), and emits one signed `usage.rollup` attestation per principal
 * via `runUsageRollup` — see apps/kernel/src/lib/usage/rollup.ts for the
 * grouping/idempotency details.
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
    const { windowStart, windowEnd } = previousUtcDayWindow(new Date());
    const results = await runUsageRollup(windowStart, windowEnd);
    const published = results.filter((r) => !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;

    log.info(
      { windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), principals: results.length, published, skipped },
      'Usage rollup sweep complete',
    );

    return NextResponse.json({
      ok: true,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      principals: results.length,
      published,
      skipped,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Usage rollup sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
