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
import { getPaymentService } from '@/src/lib/pay/pay';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { authenticatePayApp } from '@/src/lib/pay/app-settle';
import {
  applyRefundLedgerUpdates,
  checkRefundEligibility,
  resolveOriginalTransaction,
  reverseSettlementEntries,
} from '@/src/lib/pay/refund';

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
    const originalTx = await resolveOriginalTransaction(paymentId, log);
    if (!originalTx) {
      return NextResponse.json(
        { error: 'Transaction not found for paymentId' },
        { status: 404, headers: cors }
      );
    }

    if (originalTx.appDid !== auth.appDid) {
      return NextResponse.json(
        { error: 'Forbidden - payment was not created by this app' },
        { status: 403, headers: cors }
      );
    }

    const eligibility = await checkRefundEligibility(originalTx, amount);
    if (!eligibility.ok) {
      return NextResponse.json({ error: eligibility.error }, { status: eligibility.status, headers: cors });
    }
    const { txAmountDollars, requestedRefundDollars, totalRefundedDollars } = eligibility;

    // Issue refund via Stripe
    const pay = getPaymentService();
    const refundResult = await pay.refund({ paymentId, amount, reason });

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
      issuer: process.env.PLATFORM_DID || 'system',
      subject: originalTx.fromDid || 'unknown',
      scope: 'pay',
      payload: { paymentId, amount: requestedRefundDollars, reversalId, service: originalTx.service },
      correlationId,
    }).catch((err) => log.error({ err: String(err) }, 'payment.refund publish error'));

    return NextResponse.json({
      id: refundResult.id,
      paymentId: refundResult.paymentId,
      amount: refundResult.amount,
      status: refundResult.status,
      transactionId: reversalId,
    }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Refund error');
    return NextResponse.json(
      { error: 'Refund failed' },
      { status: 500, headers: cors }
    );
  }
});
