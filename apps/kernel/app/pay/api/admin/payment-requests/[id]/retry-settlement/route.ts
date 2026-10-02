/**
 * POST /pay/api/admin/payment-requests/:id/retry-settlement
 *
 * The operator's retry path for #2439: a payment_request the buyer already
 * paid through Stripe whose `.fair` ledger settlement failed or was skipped
 * (the `payment_request.settlement_failed` bus event / operator card names
 * the cause). Once the cause is fixed, this re-runs the settlement exactly
 * once — it refuses (409) when the request isn't Stripe-paid or already has
 * settlement ledger rows, so it is safe to call repeatedly — and answers 422
 * with the reason (and re-alerts) when it still can't settle.
 *
 * Auth: requireAdmin (actingAs === NODE_DID), same gate as the other
 * `/pay/api/admin/*` routes.
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { retryPaymentRequestStripeSettlement } from '@/src/lib/pay/payment-requests/checkout';
import { isServiceError } from '@/src/lib/pay/payment-requests/service';

const log = createLogger('kernel');

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;

  try {
    const result = await retryPaymentRequestStripeSettlement(id);
    if (isServiceError(result)) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ paymentRequestId: result.paymentRequest.id, settled: true });
  } catch (error) {
    log.error({ err: String(error), paymentRequestId: id }, 'payment_request settlement retry error');
    return NextResponse.json({ error: 'Failed to retry settlement' }, { status: 500 });
  }
}
