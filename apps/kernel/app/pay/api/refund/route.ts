/**
 * POST /api/refund
 *
 * Issue a refund for a Stripe payment.
 * Requires the originating app's operator-approved pay:refund service token.
 *
 * Request:
 * {
 *   paymentId: string,   // Stripe payment/session ID (= externalRef in transactions)
 *   amount?: number,     // cents — omit for full refund
 *   reason?: string
 * }
 *
 * Response:
 * {
 *   id: string,
 *   paymentId: string,
 *   amount: number,
 *   status: "pending" | "succeeded" | "failed"
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { authenticatePayApp } from '@/src/lib/pay/app-settle';
import {
  applyRefundLedgerUpdates,
  checkRefundEligibility,
  resolveOriginalTransaction,
  reverseSettlementEntries,
  refundSellerPayment,
} from '@/src/lib/pay/refund';
import { stripeByoRail } from '@/src/lib/pay/external-ref';
import { SellerNoCardRailError } from '@/src/lib/pay/rails/stripe-keys';

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

export const POST = withLogger('kernel', async (request: NextRequest, { log, correlationId }) => {
  const cors = corsHeaders(request);

  const auth = await authenticatePayApp(request, 'pay:refund');
  if ('error' in auth) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: cors }
    );
  }

  try {
    const body = await request.json();
    const { paymentId, amount, reason } = body;

    if (!paymentId || typeof paymentId !== 'string') {
      return NextResponse.json(
        { error: 'paymentId is required' },
        { status: 400, headers: cors }
      );
    }

    // Find the original transaction by externalRef.
    // Pay stores checkout session ID (cs_xxx) as externalRef, but events tickets
    // store the payment intent ID (pi_xxx). Try externalRef first, then use
    // Stripe API to resolve payment intent → checkout session.
    const originalTx = await resolveOriginalTransaction(paymentId, log, auth.appDid);
    if (!originalTx) {
      log.error({ appDid: auth.appDid }, 'Refund payment unresolved; legacy platform payments are unsupported');
      return NextResponse.json(
        { error: 'Transaction not found for paymentId; legacy platform payments require manual refund reconciliation', code: 'REFUND_PAYMENT_UNRESOLVED' },
        { status: 404, headers: cors }
      );
    }

    if (originalTx.appDid !== auth.appDid) {
      return NextResponse.json(
        { error: 'Forbidden - payment was not created by this app' },
        { status: 403, headers: cors }
      );
    }

    if (originalTx.rail !== stripeByoRail || !originalTx.toDid) {
      log.error({ transactionId: originalTx.id }, 'Legacy platform refund requires manual reconciliation');
      return NextResponse.json({ error: 'Legacy platform payments require manual refund reconciliation', code: 'LEGACY_PLATFORM_PAYMENT' }, { status: 409, headers: cors });
    }
    const eligibility = await checkRefundEligibility(originalTx, amount);
    if (!eligibility.ok) {
      return NextResponse.json({ error: eligibility.error }, { status: eligibility.status, headers: cors });
    }
    const { txAmountDollars, requestedRefundDollars, totalRefundedDollars } = eligibility;

    // Issue refund via Stripe
    const refundResult = await refundSellerPayment(originalTx, Math.round(requestedRefundDollars * 100));

    const { reversalId, isFullRefund } = await applyRefundLedgerUpdates({
      originalTx,
      paymentId,
      refundStripeId: refundResult.id,
      refundedDollars: requestedRefundDollars,
      totalRefundedDollars,
      txAmountDollars,
      reason,
    });

    await reverseSettlementEntries({ originalTx, requestedRefundDollars, txAmountDollars, isFullRefund, reason });

    publish('payment.refund', {
      issuer: originalTx.toDid,
      subject: originalTx.fromDid || 'unknown',
      scope: 'pay',
      payload: { paymentId, amount: requestedRefundDollars, reversalId, service: originalTx.service },
      correlationId,
    }).catch((err) => log.error({ err: String(err) }, 'payment.refund publish error'));

    return NextResponse.json({
      id: refundResult.id,
      paymentId,
      amount: refundResult.amount,
      status: refundResult.status,
      transactionId: reversalId,
    }, { headers: cors });
  } catch (error) {
    if (error instanceof SellerNoCardRailError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400, headers: cors });
    }
    log.error({}, 'Seller refund failed');
    return NextResponse.json(
      { error: 'Refund failed' },
      { status: 500, headers: cors }
    );
  }
});
