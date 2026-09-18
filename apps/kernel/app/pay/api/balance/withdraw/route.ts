/**
 * POST /api/balance/withdraw
 *
 * Withdraw cash balance to an external payout destination via a registered
 * `WithdrawRail` (#2172 — rail-agnostic; Stripe is the only rail enabled
 * for MJN today). Only MJN (receipt-backed, withdrawable) can be withdrawn.
 *
 * Auth: required
 *
 * #2172 (supersedes #2166's single-transaction shape): reserve -> external
 * -> confirm, not "debit + external call + record in one transaction".
 * `executeWithdrawal` (`src/lib/pay/withdraw-intent.ts`) commits the guarded
 * debit (#2166's `debitUnitIfSufficient`, unchanged) together with a durable
 * `pay.withdrawal_intents` row BEFORE the rail is ever called, so the
 * intent id (and the rail's native idempotency key, which is the same
 * value) exists no matter what happens next. This closes the residual gap
 * #2166 flagged: if the rail call succeeds but the confirming transaction
 * never commits (crash, network partition), the reservation is not lost —
 * it's a durable `pending` intent the reconciliation sweep
 * (`src/lib/pay/reconciliation.ts`) classifies as external-without-ledger,
 * instead of a Stripe transfer with no trace of ever having been attempted.
 * If the rail call itself throws, the reservation is released synchronously
 * in the same request (`releaseWithdrawal`) before this route returns.
 *
 * #2190: `account_id` is now optional and never trusted as-is. The real
 * destination is resolved SERVER-SIDE by `resolveWithdrawDestination` from
 * the acting principal's own `pay.connected_accounts` row — omitted ->
 * that DID's connected account; supplied -> must match it, else 403
 * (fail-closed, never falls back to the client-supplied value). `did` here
 * is already `resolveActingDid(identity)`, so a delegated (`act-as`)
 * session can only ever resolve to the PRINCIPAL's own connected account.
 *
 * Request:
 * { amount: number, currency: string, account_id?: string }
 *
 * Response:
 * { success: boolean, transactionId: string, transferId: string, amount: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { withLogger } from '@imajin/logger';
import { MJN, InsufficientBalanceError } from '@/src/lib/pay/ledger';
import { executeWithdrawal } from '@/src/lib/pay/withdraw-intent';
import { defaultRailForUnit } from '@/src/lib/pay/rails/registry';
import { resolveWithdrawDestination } from '@/src/lib/pay/withdraw-destination';

const MIN_WITHDRAWAL_CENTS = 100; // $1.00 minimum

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

    if (account_id !== undefined && typeof account_id !== 'string') {
      return NextResponse.json(
        { error: 'account_id must be a string' },
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

    // #2190: resolve the real destination server-side from `did`'s own
    // connected accounts — `account_id`, if supplied, is only ever a
    // selection hint, never trusted as the destination itself.
    const resolved = await resolveWithdrawDestination(did, account_id);
    if (!resolved.ok) {
      if (resolved.error === 'forbidden_destination') {
        return NextResponse.json(
          { error: 'account_id does not belong to this account' },
          { status: 403, headers: cors }
        );
      }
      return NextResponse.json(
        { error: 'No connected Stripe account for this account. Complete Connect onboarding before withdrawing.' },
        { status: 400, headers: cors }
      );
    }

    // Convert cents to dollars for comparison (balance is stored in dollars)
    const withdrawalDollars = amount / 100;

    const rail = defaultRailForUnit(MJN);
    if (!rail) {
      return NextResponse.json(
        { error: 'No withdrawal rail is configured for this unit' },
        { status: 500, headers: cors }
      );
    }

    let result;
    try {
      result = await executeWithdrawal({
        did,
        unit: MJN,
        amount: withdrawalDollars,
        rail,
        currency,
        destination: resolved.destination,
        resolutionMode: resolved.resolutionMode,
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
        transactionId: result.transactionId,
        transferId: result.externalRef,
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
