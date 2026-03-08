/**
 * POST /api/balance/topup
 *
 * Credit a DID's cash balance (service-to-service, requires API key or internal auth).
 * Topups are real money, so they always go to cash_amount.
 *
 * Request:
 * {
 *   did: string,
 *   amount: number,
 *   service: string,
 *   type: string,
 *   metadata?: Record<string, any>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances, transactions } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { genId } from '@/src/lib/id';
import { corsHeaders } from '@/src/lib/cors';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    // Service-to-service auth via API key
    const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
    const expectedKey = process.env.PAY_SERVICE_API_KEY;

    if (!expectedKey || apiKey !== expectedKey) {
      return NextResponse.json(
        { error: 'Unauthorized - invalid API key' },
        { status: 401, headers: cors }
      );
    }

    const body = await request.json();
    const { did, amount, service, type, metadata = {} } = body;

    if (!did || !amount || !service || !type) {
      return NextResponse.json(
        { error: 'Missing required fields: did, amount, service, type' },
        { status: 400, headers: cors }
      );
    }

    if (amount <= 0) {
      return NextResponse.json(
        { error: 'Amount must be positive' },
        { status: 400, headers: cors }
      );
    }

    const txId = genId('tx');

    // Atomic operation: insert transaction + update cash balance (real money)
    await db.transaction(async (tx) => {
      // Insert transaction
      await tx.insert(transactions).values({
        id: txId,
        service,
        type,
        fromDid: null, // topup has no from_did
        toDid: did,
        amount: amount.toString(),
        currency: 'USD',
        status: 'completed',
        source: 'fiat',
        metadata,
      });

      // Update or insert cash balance
      await tx
        .insert(balances)
        .values({
          did,
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
        did,
        amount,
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Topup error:', error);
    return NextResponse.json(
      { error: 'Top-up failed' },
      { status: 500, headers: cors }
    );
  }
}
