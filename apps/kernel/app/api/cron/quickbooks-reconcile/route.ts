import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { listActiveGrantOwners } from '@/src/lib/quickbooks/connector';
import { resolveAppDidForOwner } from '@/src/lib/quickbooks/realm-index';
import { settlePaidInvoices } from '@/src/lib/quickbooks/settlement';
import { requireCronAuth } from '@/src/cron/auth';

const log = createLogger('kernel');

/** This route reads live DB state per invocation and must never be statically prerendered. */
export const dynamic = 'force-dynamic';

interface OwnerReconcileResult {
  ownerDid: string;
  settled: number;
  skipped: number;
}

interface OwnerReconcileFailure {
  ownerDid: string;
  error: string;
}

/** Resolve the owner's connected app + settle their paid invoices. */
async function reconcileOwner(ownerDid: string): Promise<OwnerReconcileResult> {
  const appDid = await resolveAppDidForOwner(ownerDid);
  const result = await settlePaidInvoices(ownerDid, appDid);
  return { ownerDid, settled: result.settled.length, skipped: result.skipped.length };
}

/**
 * GET /api/cron/quickbooks-reconcile — belt-and-suspenders settlement sweep (xprize #35).
 *
 * Scheduled job, scheduled every 6 hours — see src/cron/schedule.ts for the exact
 * cron expression. Protected by Authorization: Bearer {CRON_SECRET}, same
 * pattern as /api/cron/vault-grant-expiry.
 *
 * The webhook (POST /quickbooks/api/webhook) is the fast path for settlement,
 * but a supplier's admin may never have set up the Intuit webhook, or a
 * delivery may simply be dropped. This sweep enumerates every DID with an
 * active `quickbooks:read` grant and calls `settlePaidInvoices` for each, so
 * a paid invoice is never stuck waiting on a webhook that never arrives.
 */
export async function GET(request: NextRequest) {
  // Fail closed (#2550): 503 when CRON_SECRET is unset, 401 on a wrong bearer.
  const denied = requireCronAuth(request);
  if (denied) return denied;

  try {
    const owners = await listActiveGrantOwners('quickbooks:read');
    const results: OwnerReconcileResult[] = [];
    const failures: OwnerReconcileFailure[] = [];

    for (const ownerDid of owners) {
      try {
        results.push(await reconcileOwner(ownerDid));
      } catch (err) {
        log.error({ err: String(err), ownerDid }, 'QuickBooks reconcile sweep: owner failed');
        failures.push({ ownerDid, error: String(err) });
      }
    }

    const settled = results.reduce((sum, r) => sum + r.settled, 0);
    log.info({ owners: owners.length, settled, failed: failures.length }, 'QuickBooks reconcile sweep complete');

    return NextResponse.json({ ok: true, owners: owners.length, settled, results, failures });
  } catch (error) {
    log.error({ err: String(error) }, 'QuickBooks reconcile sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
