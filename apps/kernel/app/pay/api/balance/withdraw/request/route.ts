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
import { db, balances, transactions, withdrawalRequests } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

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

  // Check balance exists and withdrawals enabled
  const [balance] = await db
    .select()
    .from(balances)
    .where(eq(balances.did, did));

  if (!balance) {
    return NextResponse.json({ error: 'No balance found' }, { status: 404, headers });
  }

  if (!balance.withdrawalsEnabled) {
    return NextResponse.json(
      { error: 'Withdrawals are not enabled for this account' },
      { status: 403, headers },
    );
  }

  const cashAvailable = Number.parseFloat(balance.cashAmount);
  if (cashAvailable < amount) {
    return NextResponse.json(
      { error: 'Insufficient cash balance', available: cashAvailable },
      { status: 400, headers },
    );
  }

  // Atomic transaction: deduct balance, create withdrawal request, create transaction
  const requestId = generateId('wr');
  const txId = generateId('tx');

  await db.transaction(async (tx) => {
    // Deduct cash balance
    await tx
      .update(balances)
      .set({
        cashAmount: sql`${balances.cashAmount} - ${amount.toString()}`,
        updatedAt: new Date(),
      })
      .where(eq(balances.did, did));

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
      status: 'pending',
      source: 'fiat',
      metadata: { emt_email, withdrawal_request_id: requestId },
    });
  });

  return NextResponse.json(
    { success: true, requestId, amount },
    { status: 200, headers },
  );
});
