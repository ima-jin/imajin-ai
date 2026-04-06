/**
 * POST /api/balance/gift
 *
 * Bulk gift credits from a business DID to recipients.
 * Auth: from_did must match session.
 * Debits from_did's cash balance for the total gifted cash_amount,
 * and credits each recipient's cash_amount and credit_amount atomically.
 *
 * Request:
 * {
 *   from_did: string,
 *   recipients: Array<{ did: string, cash_amount: number, credit_amount: number }>,
 *   metadata?: Record<string, any>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances, transactions } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { genId } from '@/src/lib/pay/id';
import { corsHeaders } from '@/src/lib/pay/cors';

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
    const { from_did, recipients, metadata = {} } = body;

    if (!from_did || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { error: 'Missing required fields: from_did, recipients (non-empty array)' },
        { status: 400, headers: cors }
      );
    }

    // Auth check: from_did must match session (or acting-as scope)
    if (effectiveDid !== from_did) {
      return NextResponse.json(
        { error: 'Forbidden - can only gift from your own DID' },
        { status: 403, headers: cors }
      );
    }

    // Validate recipients
    for (const r of recipients) {
      if (!r.did || (r.cash_amount == null && r.credit_amount == null)) {
        return NextResponse.json(
          { error: 'Each recipient must have did and at least one of cash_amount or credit_amount' },
          { status: 400, headers: cors }
        );
      }
      if ((r.cash_amount ?? 0) < 0 || (r.credit_amount ?? 0) < 0) {
        return NextResponse.json(
          { error: 'Recipient amounts must be non-negative' },
          { status: 400, headers: cors }
        );
      }
    }

    // Total cash deducted from from_did is the sum of all cash_amount gifts
    const totalCashDebit = recipients.reduce((sum: number, r: { cash_amount?: number }) => sum + (r.cash_amount ?? 0), 0);

    // Check from_did has sufficient cash
    const senderRows = await db
      .select()
      .from(balances)
      .where(eq(balances.did, from_did))
      .limit(1);

    const senderBalance = senderRows[0];
    const currentCash = senderBalance ? parseFloat(senderBalance.cashAmount) : 0;

    if (currentCash < totalCashDebit) {
      return NextResponse.json(
        { error: `Insufficient cash balance: ${currentCash} < ${totalCashDebit}` },
        { status: 400, headers: cors }
      );
    }

    const batchId = genId('batch');
    const txIds: string[] = [];

    await db.transaction(async (tx) => {
      // Debit from_did's cash
      if (totalCashDebit > 0) {
        await tx
          .update(balances)
          .set({
            cashAmount: sql`${balances.cashAmount} - ${totalCashDebit}`,
            updatedAt: new Date(),
          })
          .where(eq(balances.did, from_did));
      }

      // Credit each recipient
      for (const recipient of recipients) {
        const cashGift = recipient.cash_amount ?? 0;
        const creditGift = recipient.credit_amount ?? 0;
        const totalGift = cashGift + creditGift;

        if (totalGift === 0) continue;

        const txId = genId('tx');
        txIds.push(txId);

        await tx.insert(transactions).values({
          id: txId,
          service: 'gift',
          type: 'gift',
          fromDid: from_did,
          toDid: recipient.did,
          amount: totalGift.toString(),
          currency: 'USD',
          status: 'completed',
          source: 'fiat',
          batchId,
          metadata: {
            ...metadata,
            cash_amount: cashGift,
            credit_amount: creditGift,
          },
        });

        await tx
          .insert(balances)
          .values({
            did: recipient.did,
            cashAmount: cashGift.toString(),
            creditAmount: creditGift.toString(),
            currency: 'USD',
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: balances.did,
            set: {
              cashAmount: sql`${balances.cashAmount} + ${cashGift}`,
              creditAmount: sql`${balances.creditAmount} + ${creditGift}`,
              updatedAt: new Date(),
            },
          });
      }
    });

    return NextResponse.json(
      {
        success: true,
        batchId,
        transactions: txIds,
        from_did,
        totalCashDebit,
        recipientCount: recipients.length,
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Gift error:', error);
    return NextResponse.json(
      { error: 'Gift operation failed' },
      { status: 500, headers: cors }
    );
  }
}
