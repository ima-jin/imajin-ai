import { NextResponse, type NextRequest } from 'next/server';
import { requireAppAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { createInvoice, type CreateInvoiceLine } from '@/src/lib/quickbooks/connector';
import { buildSaleFairManifest, attachFairManifestToLot } from '@/src/lib/quickbooks/settlement';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /quickbooks/api/invoice — create a QuickBooks invoice on behalf of the
 * supplier, stamped with the delivery lot's correlationId. App-auth gated
 * (`quickbooks:write`). This write-back lets Scott's only action be the drop-off
 * gesture: the invoice fires automatically and QB stays invisible to him.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const appResult = await requireAppAuth(request, { scope: 'quickbooks:write' });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
  }
  const userDid = appResult.appAuth.userDid;
  if (!userDid) {
    return NextResponse.json({ error: 'App token has no delegating user' }, { status: 403, headers: cors });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const correlationId = typeof body.correlationId === 'string' ? body.correlationId : null;
  const customerRef = typeof body.customerRef === 'string' ? body.customerRef : null;
  const lines = Array.isArray(body.lines) ? (body.lines as CreateInvoiceLine[]) : null;
  const buyerDid = typeof body.buyerDid === 'string' ? body.buyerDid : undefined;
  if (!correlationId || !customerRef || !lines || lines.length === 0) {
    return NextResponse.json(
      { error: 'correlationId (string), customerRef (string) and a non-empty lines[] are required' },
      { status: 400, headers: cors },
    );
  }

  try {
    const invoice = await createInvoice(userDid, { correlationId, customerRef, lines });
    // The sale is now defined — build the .fair split manifest and attach it to
    // the lot so settlement can execute it when the invoice is paid.
    const fairManifest = buildSaleFairManifest(userDid, correlationId);
    await attachFairManifestToLot(correlationId, fairManifest, buyerDid);
    return NextResponse.json({ invoice, fairManifest }, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), userDid }, 'QuickBooks invoice creation failed');
    return NextResponse.json({ error: 'Invoice creation failed' }, { status: 502, headers: cors });
  }
}
