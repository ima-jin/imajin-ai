/**
 * POST /api/balance/withdraw/request
 *
 * Request an EMT withdrawal. Account must have withdrawals_enabled = true.
 * Only cash_amount can be withdrawn (not credits).
 *
 * Auth: required
 *
 * Request:
 * { amount: number, emt_email: string }
 *
 * Response:
 * { success: boolean, requestId: string, amount: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances, transactions, withdrawalRequests } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { requireAuth } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

const MIN_WITHDRAWAL_CAD = 10;

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

  const did = authResult.identity.actingAs || authResult.identity.id;

  try {
    const body = await request.json();
    const { amount, emt_email } = body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400, headers: cors }
      );
    }

    if (!emt_email || typeof emt_email !== 'string' || !emt_email.includes('@')) {
      return NextResponse.json(
        { error: 'valid emt_email is required' },
        { status: 400, headers: cors }
      );
    }

    if (amount < MIN_WITHDRAWAL_CAD) {
      return NextResponse.json(
        { error: `Minimum withdrawal is ${MIN_WITHDRAWAL_CAD} CAD` },
        { status: 400, headers: cors }
      );
    }

    // Check if withdrawals are enabled for this account
    const [balance] = await db
      .select()
      .from(balances)
      .where(eq(balances.did, did))
      .limit(1);

    if (!balance || !balance.withdrawalsEnabled) {
      return NextResponse.json(
        { error: 'Withdrawals are not enabled for this account' },
        { status: 403, headers: cors }
      );
    }

    const cashAmount = parseFloat(balance.cashAmount);

    if (cashAmount < amount) {
      return NextResponse.json(
        { error: 'Insufficient cash balance' },
        { status: 400, headers: cors }
      );
    }

    const requestId = generateId('wr');
    const txId = generateId('tx');

    // Atomic: deduct cash balance, insert withdrawal request, record transaction
    await db.transaction(async (tx) => {
      // Deduct cash immediately (prevents double-spend)
      await tx
        .update(balances)
        .set({
          cashAmount: sql`${balances.cashAmount} - ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(balances.did, did));

      // Insert withdrawal request
      await tx.insert(withdrawalRequests).values({
        id: requestId,
        did,
        amount: amount.toString(),
        currency: balance.currency || 'CAD',
        emtEmail: emt_email,
        status: 'requested',
        requestedAt: new Date(),
      });

      // Record pending transaction
      await tx.insert(transactions).values({
        id: txId,
        service: 'withdrawal',
        type: 'withdrawal',
        fromDid: did,
        toDid: 'platform',
        amount: amount.toString(),
        currency: balance.currency || 'CAD',
        status: 'pending',
        source: 'fiat',
        metadata: {
          emt_email,
          withdrawal_request_id: requestId,
        },
      });
    });

    return NextResponse.json(
      {
        success: true,
        requestId,
        amount,
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Withdrawal request error');
    return NextResponse.json(
      { error: 'Withdrawal request failed' },
      { status: 500, headers: cors }
    );
  }
});
