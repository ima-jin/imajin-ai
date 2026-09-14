/**
 * POST /api/balance/withdraw
 *
 * Withdraw cash balance to a connected Stripe account.
 * Only cash_amount can be withdrawn (not credits).
 *
 * Auth: required
 *
 * #2166: the MJN debit is a single guarded conditional UPDATE
 * (`debitUnitIfSufficient` in `src/lib/pay/ledger.ts`), not "read the
 * balance, compare in JS, then unconditionally update" — the latter is a
 * TOCTOU race that lets two concurrent withdrawals both read a stale
 * sufficient balance and both proceed, sending real money out via Stripe
 * with no backing balance. The guarded debit is reserved FIRST, inside the
 * same `db.transaction()` that inserts the transaction row, and the real
 * Stripe transfer is only created after that reservation succeeds —
 * insufficient balance throws `InsufficientBalanceError` (mapped to 402)
 * before Stripe is ever called, and no partial row is left behind. If the
 * Stripe call itself throws, the whole transaction (including the
 * reservation) rolls back. This intentionally holds the balance row's lock
 * for the duration of the Stripe API call — see the PR description for the
 * trade-off.
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
import { MJN, debitUnitIfSufficient, InsufficientBalanceError } from '@/src/lib/pay/ledger';

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

    // Convert cents to dollars for comparison (balance is stored in dollars)
    const withdrawalDollars = amount / 100;

    const stripe = getStripe();

    const txId = generateId('tx');

    // Atomic: guarded MJN debit reserves the funds FIRST; only once that
    // succeeds do we call Stripe (real money movement) and record the
    // transaction. Insufficient balance never reaches Stripe.
    let transfer: Stripe.Transfer;
    try {
      transfer = await db.transaction(async (tx) => {
        const debitResult = await debitUnitIfSufficient(tx, did, MJN, withdrawalDollars);
        if (!debitResult.ok) {
          throw new InsufficientBalanceError(MJN);
        }

        // Create Stripe Transfer to the connected account. If this throws,
        // the guarded debit above rolls back with the rest of the
        // transaction — no balance is lost without a corresponding payout.
        const stripeTransfer = await stripe.transfers.create({
          amount,
          currency: currency.toLowerCase(),
          destination: account_id,
          metadata: {
            did,
            type: 'withdrawal',
          },
        });

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
          stripeId: stripeTransfer.id,
          metadata: {
            transfer_id: stripeTransfer.id,
            account_id,
          },
        });

        return stripeTransfer;
      });
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return NextResponse.json({ error: err.message }, { status: 402, headers: cors });
      }
      throw err;
    }

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
