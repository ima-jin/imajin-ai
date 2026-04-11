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
import { eq, sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  // Service-to-service auth via API key
  const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
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
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' as any });
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
        { error: 'Transaction already refunded' },
        { status: 400, headers: cors }
      );
    }

    // Issue refund via Stripe
    const pay = getPaymentService();
    const refundResult = await pay.refund({ paymentId, amount, reason });

    // Convert tx amount (dollars) back to cents for response consistency
    const txAmountDollars = parseFloat(originalTx.amount);
    const refundedDollars = amount ? amount / 100 : txAmountDollars;

    // Mark original transaction as refunded
    await db
      .update(transactions)
      .set({ status: 'refunded' })
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

      for (const stx of settlementTxs) {
        if (stx.status === 'refunded') continue;

        const stxAmount = parseFloat(stx.amount);

        // Mark settlement entry as refunded
        await db
          .update(transactions)
          .set({ status: 'refunded' })
          .where(eq(transactions.id, stx.id));

        // Create reversal entry for this settlement
        const stxReversalId = generateId('tx');
        await db.insert(transactions).values({
          id: stxReversalId,
          service: stx.service,
          type: 'refund',
          fromDid: stx.toDid,
          toDid: stx.fromDid ?? 'unknown',
          amount: stxAmount.toString(),
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

        // Debit the recipient (host or platform)
        if (stx.toDid) {
          await db
            .update(balances)
            .set({
              cashAmount: sql`GREATEST(${balances.cashAmount} - ${stxAmount}, 0)`,
              updatedAt: new Date(),
            })
            .where(eq(balances.did, stx.toDid));
        }
      }
    }

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
