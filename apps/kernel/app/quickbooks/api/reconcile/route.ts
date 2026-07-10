import { NextResponse, type NextRequest } from 'next/server';
import { requireAppAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { settlePaidInvoices } from '@/src/lib/quickbooks/settlement';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /quickbooks/api/reconcile — read the supplier's QB invoices and settle
 * any newly-paid ones (Balance == 0) against their delivery lots. App-auth gated
 * (`quickbooks:read`). Idempotent: lots already `settled` are skipped.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const appResult = await requireAppAuth(request, { scope: 'quickbooks:read' });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
  }
  const userDid = appResult.appAuth.userDid;
  if (!userDid) {
    return NextResponse.json({ error: 'App token has no delegating user' }, { status: 403, headers: cors });
  }

  try {
    const result = await settlePaidInvoices(userDid);
    return NextResponse.json(result, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), userDid }, 'QuickBooks reconcile failed');
    return NextResponse.json({ error: 'Reconcile failed' }, { status: 502, headers: cors });
  }
}
