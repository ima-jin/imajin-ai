/**
 * POST /api/settle
 *
 * Execute a .fair multi-party settlement.
 * Validates from_did has sufficient balance, then atomically:
 * - Debit from_did (credits first, then cash)
 * - Credit each recipient in the fair_manifest chain (cash — real value earned)
 * - Log all transactions
 *
 * Request:
 * {
 *   from_did: string,
 *   total_amount: number,
 *   service: string,
 *   type: string,
 *   fair_manifest: {
 *     chain: Array<{ did: string, amount: number, role: string }>
 *   },
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
    const { from_did, total_amount, service, type, fair_manifest, metadata = {} } = body;

    if (!from_did || !total_amount || !service || !type || !fair_manifest) {
      return NextResponse.json(
        { error: 'Missing required fields: from_did, total_amount, service, type, fair_manifest' },
        { status: 400, headers: cors }
      );
    }

    if (!fair_manifest.chain || !Array.isArray(fair_manifest.chain)) {
      return NextResponse.json(
        { error: 'fair_manifest.chain must be an array' },
        { status: 400, headers: cors }
      );
    }

    // Validate chain
    let chainTotal = 0;
    for (const item of fair_manifest.chain) {
      if (!item.did || !item.amount || !item.role) {
        return NextResponse.json(
          { error: 'Each chain item must have did, amount, and role' },
          { status: 400, headers: cors }
        );
      }
      chainTotal += item.amount;
    }

    // Verify total matches chain sum
    if (Math.abs(chainTotal - total_amount) > 0.01) {
      return NextResponse.json(
        { error: `Chain total (${chainTotal}) does not match total_amount (${total_amount})` },
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

    if (totalBalance < total_amount) {
      return NextResponse.json(
        { error: `Insufficient balance: ${totalBalance} < ${total_amount}` },
        { status: 400, headers: cors }
      );
    }

    // Determine how much to burn from each bucket (credits first)
    const creditBurn = Math.min(currentCredit, total_amount);
    const cashBurn = total_amount - creditBurn;

    let source: 'credit' | 'fiat' | 'mixed';
    if (cashBurn === 0) {
      source = 'credit';
    } else if (creditBurn === 0) {
      source = 'fiat';
    } else {
      source = 'mixed';
    }

    const batchId = genId('batch');
    const txIds: string[] = [];

    // Atomic settlement
    await db.transaction(async (tx) => {
      // Debit from_did (credits first, then cash)
      await tx
        .update(balances)
        .set({
          creditAmount: sql`${balances.creditAmount} - ${creditBurn}`,
          cashAmount: sql`${balances.cashAmount} - ${cashBurn}`,
          updatedAt: new Date(),
        })
        .where(eq(balances.did, from_did));

      // Credit each recipient (earnings go to cash — real value created)
      for (const recipient of fair_manifest.chain) {
        const txId = genId('tx');
        txIds.push(txId);

        // Insert transaction
        await tx.insert(transactions).values({
          id: txId,
          service,
          type,
          fromDid: from_did,
          toDid: recipient.did,
          amount: recipient.amount.toString(),
          currency: 'USD',
          status: 'completed',
          source,
          fairManifest: fair_manifest,
          batchId,
          metadata: {
            ...metadata,
            role: recipient.role,
          },
        });

        // Credit recipient cash balance
        await tx
          .insert(balances)
          .values({
            did: recipient.did,
            cashAmount: recipient.amount.toString(),
            creditAmount: '0',
            currency: 'USD',
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: balances.did,
            set: {
              cashAmount: sql`${balances.cashAmount} + ${recipient.amount}`,
              updatedAt: new Date(),
            },
          });
      }
    });

    return NextResponse.json(
      {
        settled: true,
        batchId,
        transactions: txIds,
        total_amount,
        recipients: fair_manifest.chain.length,
        source,
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Settlement error:', error);
    return NextResponse.json(
      { error: 'Settlement failed' },
      { status: 500, headers: cors }
    );
  }
}
