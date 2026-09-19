/**
 * GET /pay/api/payment-requests/:id — issuer or recipient only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { getPaymentRequestById } from '@/src/lib/pay/payment-requests/service';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cors = corsHeaders(request);
  const { id } = await params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const callerDid = resolveActingDid(authResult.identity);

  try {
    const row = await getPaymentRequestById(id);
    if (!row) {
      return NextResponse.json({ error: 'payment_request not found' }, { status: 404, headers: cors });
    }
    if (row.issuerDid !== callerDid && row.recipientDid !== callerDid) {
      return NextResponse.json({ error: 'Not authorized to view this payment_request' }, { status: 403, headers: cors });
    }
    return NextResponse.json(row, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), paymentRequestId: id }, 'payment_request get error');
    return NextResponse.json({ error: 'Failed to load payment_request' }, { status: 500, headers: cors });
  }
}
