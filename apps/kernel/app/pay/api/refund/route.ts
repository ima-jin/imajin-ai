/**
 * POST /api/refund
 *
 * Issue a refund for a Stripe payment.
 * Service-to-service only — requires PAY_SERVICE_API_KEY.
 *
 * Request:
 * {
 *   paymentId: string,   // Stripe payment/session ID (= stripeId in transactions)
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
import { db, transactions, balances } from '@/src/db';
import { and, eq, sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log, correlationId }) => {
  const cors = corsHeaders(request);

  // Service-to-service auth via API key
  const apiKey = request.headers.get('authorization')?.replaceAll('Bearer ', '');
  const expectedKey = process.env.PAY_SERVICE_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json(
      { error: 'Unauthorized - invalid API key' },
      { status: 401, headers: cors }
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

    // Find the original transaction by stripeId.
    // Pay stores checkout session ID (cs_xxx) as stripeId, but events tickets
    // store the payment intent ID (pi_xxx). Try stripeId first, then use
    // Stripe API to resolve payment intent → checkout session.
    let [originalTx] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.stripeId, paymentId))
      .limit(1);

    if (!originalTx && paymentId.startsWith('pi_')) {
      // Events tickets store payment intent ID (pi_xxx), but pay ledger stores
      // checkout session ID (cs_xxx). Resolve via Stripe API.
      try {
        const Stripe = (await import('stripe')).default;
        if (!process.env.STRIPE_SECRET_KEY) {
          throw new Error('STRIPE_SECRET_KEY not configured');
        }
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' as any });
        const sessions = await stripe.checkout.sessions.list({
          payment_intent: paymentId,
          limit: 1,
        });
        if (sessions.data[0]) {
          const results = await db
            .select()
            .from(transactions)
            .where(eq(transactions.stripeId, sessions.data[0].id))
            .limit(1);
          originalTx = results[0];
        }
      } catch (e) {
        log.error({ err: String(e) }, '[refund] Failed to resolve payment intent to session');
      }
    }

    if (!originalTx) {
      return NextResponse.json(
        { error: 'Transaction not found for paymentId' },
        { status: 404, headers: cors }
      );
    }

    if (originalTx.status === 'refunded') {
      return NextResponse.json(
        { error: 'Transaction already fully refunded' },
        { status: 400, headers: cors }
      );
    }

    // Compute amounts up front so the guard can use them.
    const txAmountDollars = Number.parseFloat(originalTx.amount);
    const requestedRefundDollars = amount ? amount / 100 : txAmountDollars;

    // For partially-refunded txs, sum all existing refund entries and verify
    // the new request doesn't exceed the remaining balance.
    const existingRefundTxs = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'refund'),
          sql`${transactions.metadata}->>'originalTxId' = ${originalTx.id}`
        )
      );
    const totalRefundedDollars = existingRefundTxs.reduce(
      (sum, r) => sum + Number.parseFloat(r.amount),
      0
    );

    if (totalRefundedDollars + requestedRefundDollars > txAmountDollars + 0.005) {
      return NextResponse.json(
        { error: 'Refund would exceed original transaction amount' },
        { status: 400, headers: cors }
      );
    }

    // Issue refund via Stripe
    const pay = getPaymentService();
    const refundResult = await pay.refund({ paymentId, amount, reason });

    // Determine whether this refund fully settles the original transaction.
    const newTotalRefunded = totalRefundedDollars + requestedRefundDollars;
    const isFullRefund = newTotalRefunded >= txAmountDollars - 0.005;
    const newTxStatus = isFullRefund ? 'refunded' : 'partially_refunded';

    // Alias for clarity in the rest of the function (dollars).
    const refundedDollars = requestedRefundDollars;

    // Mark original transaction as refunded / partially_refunded
    await db
      .update(transactions)
      .set({ status: newTxStatus })
      .where(eq(transactions.id, originalTx.id));

    // Create reversal transaction entry
    const reversalId = generateId('tx');
    await db.insert(transactions).values({
      id: reversalId,
      service: originalTx.service,
      type: 'refund',
      fromDid: originalTx.toDid,
      toDid: originalTx.fromDid ?? 'unknown',
      amount: refundedDollars.toString(),
      currency: originalTx.currency,
      status: 'completed',
      source: 'fiat',
      stripeId: refundResult.id,
      metadata: {
        originalTxId: originalTx.id,
        originalStripeId: paymentId,
        ...(reason && { reason }),
      },
    });

    // Adjust balances for the checkout transaction
    if (originalTx.toDid) {
      await db
        .update(balances)
        .set({
          cashAmount: sql`GREATEST(${balances.cashAmount} - ${refundedDollars}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(balances.did, originalTx.toDid));
    }

    if (originalTx.fromDid) {
      await db
        .insert(balances)
        .values({
          did: originalTx.fromDid,
          cashAmount: refundedDollars.toString(),
          creditAmount: '0',
          currency: originalTx.currency,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: balances.did,
          set: {
            cashAmount: sql`${balances.cashAmount} + ${refundedDollars}`,
            updatedAt: new Date(),
          },
        });
    }

    // Reverse settlement entries (host share + platform fee)
    // Settlement transactions link back via metadata.stripeSessionId matching the checkout's stripeId
    const checkoutStripeId = originalTx.stripeId;
    if (checkoutStripeId) {
      const settlementTxs = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.metadata}->>'stripeSessionId' = ${checkoutStripeId}`);

      // Reverse settlement entries proportionally: each entry is wound back by
      // (requestedRefundDollars / txAmountDollars) of its original amount so that
      // N per-ticket refunds each reclaim their fair share without over-reversing.
      const refundFraction = requestedRefundDollars / txAmountDollars;

      for (const stx of settlementTxs) {
        if (stx.status === 'refunded') continue;

        const stxAmount = Number.parseFloat(stx.amount);
        // Proportional reversal amount, rounded to 8 decimal places.
        const stxReversalAmount = Math.round(stxAmount * refundFraction * 1e8) / 1e8;
        if (stxReversalAmount <= 0) continue;

        // Mark settlement entry as fully or partially refunded.
        const newSettlementStatus = isFullRefund ? 'refunded' : 'partially_refunded';
        await db
          .update(transactions)
          .set({ status: newSettlementStatus })
          .where(eq(transactions.id, stx.id));

        // Create reversal entry for this settlement
        const stxReversalId = generateId('tx');
        await db.insert(transactions).values({
          id: stxReversalId,
          service: stx.service,
          type: 'refund',
          fromDid: stx.toDid,
          toDid: stx.fromDid ?? 'unknown',
          amount: stxReversalAmount.toString(),
          currency: stx.currency,
          status: 'completed',
          source: 'fiat',
          batchId: stx.batchId,
          metadata: {
            originalTxId: stx.id,
            refundOfSettlement: true,
            ...(reason && { reason }),
          },
        });

        // Debit the recipient (host or platform) proportionally.
        if (stx.toDid) {
          await db
            .update(balances)
            .set({
              cashAmount: sql`GREATEST(${balances.cashAmount} - ${stxReversalAmount}, 0)`,
              updatedAt: new Date(),
            })
            .where(eq(balances.did, stx.toDid));
        }
      }
    }

    publish('payment.refund', {
      issuer: process.env.PLATFORM_DID || 'system',
      subject: originalTx.fromDid || 'unknown',
      scope: 'pay',
      payload: { paymentId, amount: refundedDollars, reversalId, service: originalTx.service },
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
