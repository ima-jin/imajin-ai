import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { runReconciliation } from '@/src/lib/pay/reconciliation';

const log = createLogger('kernel');

/** This route reads live DB + rail state per invocation and must never be statically prerendered. */
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/withdrawal-reconcile (#2172) — belt-and-suspenders sweep
 * closing the "Stripe succeeded, ledger commit failed" gap.
 *
 * Same auth/shape as `/api/cron/quickbooks-reconcile`: Vercel Cron,
 * protected by `Authorization: Bearer {CRON_SECRET}` — see `vercel.json`
 * for the schedule. The webhook fast path
 * (`app/pay/api/webhook/route.ts`'s `transfer.created` case) confirms most
 * intents immediately; this sweep is what catches everything a dropped or
 * never-configured webhook delivery would otherwise leave stuck, and is
 * the ONLY place that classifies rail-transfer-vs-ledger discrepancies.
 * Writes no balances — see `src/lib/pay/reconciliation.ts`'s docblock.
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
    const result = await runReconciliation();
    const totals = result.rails.reduce(
      (acc, r) => ({
        matched: acc.matched + r.matched,
        externalWithoutLedger: acc.externalWithoutLedger + r.externalWithoutLedger,
        pendingTimeout: acc.pendingTimeout + r.pendingTimeout,
      }),
      { matched: 0, externalWithoutLedger: 0, pendingTimeout: 0 },
    );

    log.info(
      { rails: result.rails.length, ...totals },
      'Withdrawal reconciliation sweep complete',
    );

    return NextResponse.json({ ok: true, rails: result.rails });
  } catch (error) {
    log.error({ err: String(error) }, 'Withdrawal reconciliation sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
