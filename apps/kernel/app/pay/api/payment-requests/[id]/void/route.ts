/**
 * POST /pay/api/payment-requests/:id/void — issuer-only. status -> `void`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { isServiceError, voidPaymentRequest } from '@/src/lib/pay/payment-requests/service';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cors = corsHeaders(request);
  const { id } = await params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const callerDid = resolveActingDid(authResult.identity);

  try {
    const result = await voidPaymentRequest({ id, callerDid });
    if (isServiceError(result)) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), paymentRequestId: id }, 'payment_request void error');
    return NextResponse.json({ error: 'Failed to void payment_request' }, { status: 500, headers: cors });
  }
}
