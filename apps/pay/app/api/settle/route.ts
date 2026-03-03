/**
 * POST /api/settle
 *
 * Execute a .fair multi-party settlement.
 * Validates from_did has sufficient balance, then atomically:
 * - Debit from_did
 * - Credit each recipient in the fair_manifest chain
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

    // Check sender has sufficient balance
    const senderBalanceRows = await db
      .select()
      .from(balances)
      .where(eq(balances.did, from_did))
      .limit(1);

    const senderBalance = senderBalanceRows[0];
    const currentBalance = senderBalance ? parseFloat(senderBalance.amount) : 0;

    if (currentBalance < total_amount) {
      return NextResponse.json(
        { error: `Insufficient balance: ${currentBalance} < ${total_amount}` },
        { status: 400, headers: cors }
      );
    }

    const batchId = genId('batch');
    const txIds: string[] = [];

    // Atomic settlement
    await db.transaction(async (tx) => {
      // Debit from_did
      await tx
        .update(balances)
        .set({
          amount: sql`${balances.amount} - ${total_amount}`,
          updatedAt: new Date(),
        })
        .where(eq(balances.did, from_did));

      // Credit each recipient and log transactions
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
          fairManifest: fair_manifest,
          batchId,
          metadata: {
            ...metadata,
            role: recipient.role,
          },
        });

        // Credit recipient
        await tx
          .insert(balances)
          .values({
            did: recipient.did,
            amount: recipient.amount.toString(),
            currency: 'USD',
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: balances.did,
            set: {
              amount: sql`${balances.amount} + ${recipient.amount}`,
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
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Settlement error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Settlement failed' },
      { status: 500, headers: cors }
    );
  }
}
