/**
 * POST /pay/api/balance/withdraw/request
 *
 * Request an EMT withdrawal of cash balance.
 * Requires withdrawals to be enabled for the account.
 *
 * Auth: required
 *
 * Request: { amount: number, emt_email: string }
 * Response: { success: boolean, requestId: string, amount: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, transactions, withdrawalRequests } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { withLogger } from '@imajin/logger';
import { MJN, debitUnitIfSufficient, getBalanceRow, InsufficientBalanceError } from '@/src/lib/pay/ledger';

const MIN_WITHDRAWAL = 10; // $10.00 minimum

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest) => {
  const headers = corsHeaders(request);

  // Auth
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers });
  }
  const did = resolveActingDid(authResult.identity);

  // Parse body
  let body: { amount?: number; emt_email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers });
  }

  const { amount, emt_email } = body;

  // Validate
  if (!amount || typeof amount !== 'number' || amount < MIN_WITHDRAWAL) {
    return NextResponse.json(
      { error: `Minimum withdrawal is $${MIN_WITHDRAWAL}` },
      { status: 400, headers },
    );
  }
  if (!emt_email || typeof emt_email !== 'string' || !emt_email.includes('@')) {
    return NextResponse.json(
      { error: 'Valid emt_email is required' },
      { status: 400, headers },
    );
  }

  // Check MJN balance exists and withdrawals enabled — the only unit
  // withdraw rails may ever read (#2016).
  const balance = await getBalanceRow(db, did, MJN);

  if (!balance) {
    return NextResponse.json({ error: 'No balance found' }, { status: 404, headers });
  }

  if (!balance.withdrawalsEnabled) {
    return NextResponse.json(
      { error: 'Withdrawals are not enabled for this account' },
      { status: 403, headers },
    );
  }

  // #2166: sufficiency is enforced atomically inside the transaction below
  // via a guarded conditional UPDATE (`debitUnitIfSufficient`) — not this
  // pre-transaction `amountOf(balance)` read, which is a TOCTOU race: two
  // concurrent withdrawal requests against the same balance could both read
  // a stale sufficient amount and both proceed, driving the balance
  // negative. `balance` above is still read for the 404/403 checks, which
  // are not sufficiency checks and don't need to be atomic.

  // Atomic transaction: guarded debit, create withdrawal request, create transaction
  const requestId = generateId('wr');
  const txId = generateId('tx');

  try {
    await db.transaction(async (tx) => {
      const debitResult = await debitUnitIfSufficient(tx, did, MJN, amount);
      if (!debitResult.ok) {
        throw new InsufficientBalanceError(MJN);
      }

      // Insert withdrawal request
      await tx.insert(withdrawalRequests).values({
        id: requestId,
        did,
        amount: amount.toString(),
        currency: 'CAD',
        emtEmail: emt_email,
        status: 'requested',
      });

      // Insert transaction record
      await tx.insert(transactions).values({
        id: txId,
        service: 'withdrawal',
        type: 'withdrawal',
        fromDid: did,
        toDid: 'platform',
        amount: amount.toString(),
        currency: 'CAD',
        unit: MJN,
        sourceKind: 'receipt',
        status: 'pending',
        source: 'fiat',
        metadata: { emt_email, withdrawal_request_id: requestId },
      });
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return NextResponse.json({ error: err.message }, { status: 402, headers });
    }
    throw err;
  }

  return NextResponse.json(
    { success: true, requestId, amount },
    { status: 200, headers },
  );
});
