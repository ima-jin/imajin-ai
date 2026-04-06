/**
 * POST /api/balance/transfer
 *
 * Transfer balance from one DID to another.
 * Auth: sender must be authenticated as from_did.
 * Burns credits first, then cash.
 *
 * Request:
 * {
 *   from_did: string,
 *   to_did: string,
 *   amount: number,
 *   metadata?: Record<string, any>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances, transactions } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: cors }
      );
    }

    const effectiveDid = authResult.identity.actingAs || authResult.identity.id;

    const body = await request.json();
    const { from_did, to_did, amount, metadata = {} } = body;

    if (!from_did || !to_did || !amount) {
      return NextResponse.json(
        { error: 'Missing required fields: from_did, to_did, amount' },
        { status: 400, headers: cors }
      );
    }

    // Auth check: sender must match session (or acting-as scope)
    if (effectiveDid !== from_did) {
      return NextResponse.json(
        { error: 'Forbidden - can only transfer from your own DID' },
        { status: 403, headers: cors }
      );
    }

    if (amount <= 0) {
      return NextResponse.json(
        { error: 'Amount must be positive' },
        { status: 400, headers: cors }
      );
    }

    if (from_did === to_did) {
      return NextResponse.json(
        { error: 'Cannot transfer to yourself' },
        { status: 400, headers: cors }
      );
    }

    // Check sender has sufficient balance (cash + credit)
    const senderBalanceRows = await db
      .select()
      .from(balances)
      .where(eq(balances.did, from_did))
      .limit(1);

    const senderBalance = senderBalanceRows[0];
    const currentCash = senderBalance ? parseFloat(senderBalance.cashAmount) : 0;
    const currentCredit = senderBalance ? parseFloat(senderBalance.creditAmount) : 0;
    const totalBalance = currentCash + currentCredit;

    if (totalBalance < amount) {
      return NextResponse.json(
        { error: 'Insufficient balance' },
        { status: 400, headers: cors }
      );
    }

    // Determine how much to burn from each bucket (credits first)
    const creditBurn = Math.min(currentCredit, amount);
    const cashBurn = amount - creditBurn;

    // Determine source label
    let source: 'credit' | 'fiat' | 'mixed';
    if (cashBurn === 0) {
      source = 'credit';
    } else if (creditBurn === 0) {
      source = 'fiat';
    } else {
      source = 'mixed';
    }

    const txId = generateId('tx');

    // Atomic operation: debit sender, credit recipient, log transaction
    await db.transaction(async (tx) => {
      // Insert transaction
      await tx.insert(transactions).values({
        id: txId,
        service: 'transfer',
        type: 'transfer',
        fromDid: from_did,
        toDid: to_did,
        amount: amount.toString(),
        currency: 'USD',
        status: 'completed',
        source,
        metadata,
      });

      // Debit sender (credits first, then cash)
      await tx
        .update(balances)
        .set({
          creditAmount: sql`${balances.creditAmount} - ${creditBurn}`,
          cashAmount: sql`${balances.cashAmount} - ${cashBurn}`,
          updatedAt: new Date(),
        })
        .where(eq(balances.did, from_did));

      // Credit recipient cash bucket (transfers go to cash — real value)
      await tx
        .insert(balances)
        .values({
          did: to_did,
          cashAmount: amount.toString(),
          creditAmount: '0',
          currency: 'USD',
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: balances.did,
          set: {
            cashAmount: sql`${balances.cashAmount} + ${amount}`,
            updatedAt: new Date(),
          },
        });
    });

    return NextResponse.json(
      {
        success: true,
        transactionId: txId,
        from_did,
        to_did,
        amount,
        source,
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Transfer error:', error);
    return NextResponse.json(
      { error: 'Transfer failed' },
      { status: 500, headers: cors }
    );
  }
}
