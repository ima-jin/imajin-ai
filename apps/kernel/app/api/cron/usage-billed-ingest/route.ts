import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { runBilledUsageIngestion } from '@/src/lib/usage/billed/ingest-job';

const log = createLogger('kernel');

/** This route reads live DB/provider state per invocation and must never be statically prerendered. */
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/usage-billed-ingest (#1076 Stage 1)
 *
 * Vercel Cron job, scheduled daily — see vercel.json for the exact cron
 * expression. Protected by Authorization: Bearer {CRON_SECRET}, same pattern
 * as the other cron routes (e.g. /api/cron/quickbooks-reconcile).
 *
 * For every principal with an active `anthropic:billing` or `openai:billing`
 * grant, pulls yesterday + month-to-date from that provider's own usage/cost
 * admin API and upserts `usage.billed`. Fails open per owner+provider — see
 * `runBilledUsageIngestion`'s doc comment.
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
    const sweep = await runBilledUsageIngestion();
    return NextResponse.json({ ok: true, ...sweep });
  } catch (error) {
    log.error({ err: String(error) }, 'billed usage ingestion sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
