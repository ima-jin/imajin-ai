/**
 * POST /api/balance/transfer
 *
 * Transfer balance from one DID to another.
 * Auth: sender must be authenticated as from_did.
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
import { extractToken, validateToken } from '@/lib/auth';
import { genId } from '@/src/lib/id';
import { corsHeaders } from '@/src/lib/cors';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const token = extractToken(request.headers.get('authorization'));
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized - no token provided' },
        { status: 401, headers: cors }
      );
    }

    const validation = await validateToken(token);
    if (!validation.valid || !validation.identity) {
      return NextResponse.json(
        { error: 'Unauthorized - invalid token' },
        { status: 401, headers: cors }
      );
    }

    const body = await request.json();
    const { from_did, to_did, amount, metadata = {} } = body;

    if (!from_did || !to_did || !amount) {
      return NextResponse.json(
        { error: 'Missing required fields: from_did, to_did, amount' },
        { status: 400, headers: cors }
      );
    }

    // Auth check: sender must match session
    if (validation.identity.id !== from_did) {
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

    // Check sender has sufficient balance
    const senderBalanceRows = await db
      .select()
      .from(balances)
      .where(eq(balances.did, from_did))
      .limit(1);

    const senderBalance = senderBalanceRows[0];
    const currentBalance = senderBalance ? parseFloat(senderBalance.amount) : 0;

    if (currentBalance < amount) {
      return NextResponse.json(
        { error: 'Insufficient balance' },
        { status: 400, headers: cors }
      );
    }

    const txId = genId('tx');

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
        metadata,
      });

      // Debit sender
      await tx
        .update(balances)
        .set({
          amount: sql`${balances.amount} - ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(balances.did, from_did));

      // Credit recipient
      await tx
        .insert(balances)
        .values({
          did: to_did,
          amount: amount.toString(),
          currency: 'USD',
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: balances.did,
          set: {
            amount: sql`${balances.amount} + ${amount}`,
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
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Transfer error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Transfer failed' },
      { status: 500, headers: cors }
    );
  }
}
