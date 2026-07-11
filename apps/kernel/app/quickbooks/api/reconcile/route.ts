import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { settlePaidInvoices } from '@/src/lib/quickbooks/settlement';
import { quickbooksPreflight, requireQuickBooksUser } from '@/src/lib/quickbooks/route-helpers';

const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return quickbooksPreflight(request);
}

/**
 * POST /quickbooks/api/reconcile — read the supplier's QB invoices and settle
 * any newly-paid ones (Balance == 0) against their delivery lots. App-auth gated
 * (`quickbooks:read`). Idempotent: lots already `settled` are skipped.
 */
export async function POST(request: NextRequest) {
  const auth = await requireQuickBooksUser(request, 'quickbooks:read');
  if ('response' in auth) return auth.response;
  const { userDid, cors } = auth;

  try {
    const result = await settlePaidInvoices(userDid);
    return NextResponse.json(result, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), userDid }, 'QuickBooks reconcile failed');
    return NextResponse.json({ error: 'Reconcile failed' }, { status: 502, headers: cors });
  }
}
