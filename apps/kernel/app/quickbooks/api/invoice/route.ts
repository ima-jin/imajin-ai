import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { createInvoice, type CreateInvoiceLine } from '@/src/lib/quickbooks/connector';
import { buildSaleFairManifest, attachFairManifestToLot } from '@/src/lib/quickbooks/settlement';
import { quickbooksPreflight, requireQuickBooksUser } from '@/src/lib/quickbooks/route-helpers';

const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return quickbooksPreflight(request);
}

/**
 * POST /quickbooks/api/invoice — create a QuickBooks invoice on behalf of the
 * supplier, stamped with the delivery lot's correlationId. App-auth gated
 * (`quickbooks:write`). This write-back lets Scott's only action be the drop-off
 * gesture: the invoice fires automatically and QB stays invisible to him.
 */
export async function POST(request: NextRequest) {
  const auth = await requireQuickBooksUser(request, 'quickbooks:write');
  if ('response' in auth) return auth.response;
  const { userDid, cors } = auth;

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
