/**
 * POST /api/balance/withdraw
 *
 * Withdraw cash balance to a connected Stripe account.
 * Only cash_amount can be withdrawn (not credits).
 *
 * Auth: required
 *
 * Request:
 * { amount: number, currency: string, account_id: string }
 *
 * Response:
 * { success: boolean, transactionId: string, transferId: string, amount: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db, transactions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { withLogger } from '@imajin/logger';
import { MJN, amountOf, debitUnit, getBalanceRow } from '@/src/lib/pay/ledger';

const MIN_WITHDRAWAL_CENTS = 100; // $1.00 minimum

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
    });
  }
  return _stripe;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: cors }
    );
  }

  const did = resolveActingDid(authResult.identity);

  try {
    const body = await request.json();
    const { amount, currency = 'CAD', account_id } = body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400, headers: cors }
      );
    }

    if (!account_id) {
      return NextResponse.json(
        { error: 'account_id (Stripe Connect account) is required' },
        { status: 400, headers: cors }
      );
    }

    // amount is in cents; enforce minimum
    if (amount < MIN_WITHDRAWAL_CENTS) {
      return NextResponse.json(
        { error: `Minimum withdrawal is ${MIN_WITHDRAWAL_CENTS / 100} ${currency}` },
        { status: 400, headers: cors }
      );
    }

    // Check MJN balance — the only unit withdraw rails may ever read (#2016).
    const balance = await getBalanceRow(db, did, MJN);

    const cashAmount = amountOf(balance);
    // Convert cents to dollars for comparison (balance is stored in dollars)
    const withdrawalDollars = amount / 100;

    if (cashAmount < withdrawalDollars) {
      return NextResponse.json(
        { error: 'Insufficient cash balance' },
        { status: 400, headers: cors }
      );
    }

    const stripe = getStripe();

    // Create Stripe Transfer to the connected account
    const transfer = await stripe.transfers.create({
      amount,
      currency: currency.toLowerCase(),
      destination: account_id,
      metadata: {
        did,
        type: 'withdrawal',
      },
    });

    const txId = generateId('tx');

    // Atomic: deduct MJN balance + record transaction
    await db.transaction(async (tx) => {
      await tx.insert(transactions).values({
        id: txId,
        service: 'pay',
        type: 'withdrawal',
        fromDid: did,
        toDid: account_id,
        amount: withdrawalDollars.toString(),
        currency: currency.toUpperCase(),
        unit: MJN,
        sourceKind: 'receipt',
        status: 'completed',
        source: 'fiat',
        stripeId: transfer.id,
        metadata: {
          transfer_id: transfer.id,
          account_id,
        },
      });

      await debitUnit(tx, did, MJN, withdrawalDollars);
    });

    return NextResponse.json(
      {
        success: true,
        transactionId: txId,
        transferId: transfer.id,
        amount,
        currency: currency.toUpperCase(),
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Withdrawal error');
    return NextResponse.json(
      { error: 'Withdrawal failed' },
      { status: 500, headers: cors }
    );
  }
});
