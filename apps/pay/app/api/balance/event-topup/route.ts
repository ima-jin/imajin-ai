/**
 * POST /api/balance/event-topup
 *
 * Multiplier-based gifting for events.
 * Auth: from_did must match session.
 *
 * multiplier 1.0 = refund only (ticket price to cash)
 * multiplier 10.0 = ticket price to cash + 9x to credits
 *
 * Request:
 * {
 *   from_did: string,
 *   event_id: string,
 *   multiplier: number,           // >= 1.0
 *   recipient_dids: string[],
 *   metadata: {
 *     ticket_price: number,       // per-recipient ticket price
 *     [key: string]: any
 *   }
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances, transactions } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { genId } from '@/src/lib/id';
import { corsHeaders } from '@/src/lib/cors';

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
    const { from_did, event_id, multiplier, recipient_dids, metadata = {} } = body;

    if (!from_did || !event_id || multiplier == null || !recipient_dids || !Array.isArray(recipient_dids) || recipient_dids.length === 0) {
      return NextResponse.json(
        { error: 'Missing required fields: from_did, event_id, multiplier, recipient_dids (non-empty array)' },
        { status: 400, headers: cors }
      );
    }

    if (multiplier < 1.0) {
      return NextResponse.json(
        { error: 'multiplier must be >= 1.0' },
        { status: 400, headers: cors }
      );
    }

    const ticketPrice: number = metadata.ticket_price;
    if (!ticketPrice || ticketPrice <= 0) {
      return NextResponse.json(
        { error: 'metadata.ticket_price must be a positive number' },
        { status: 400, headers: cors }
      );
    }

    // Auth check: from_did must match session (or acting-as scope)
    if (effectiveDid !== from_did) {
      return NextResponse.json(
        { error: 'Forbidden - can only top up from your own DID' },
        { status: 403, headers: cors }
      );
    }

    // Per-recipient amounts:
    // cash = ticket_price (refund of real money)
    // credits = ticket_price * (multiplier - 1)  (bonus house money)
    const cashPerRecipient = ticketPrice;
    const creditPerRecipient = ticketPrice * (multiplier - 1);

    const totalCashDebit = cashPerRecipient * recipient_dids.length;

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
      await tx
        .update(balances)
        .set({
          cashAmount: sql`${balances.cashAmount} - ${totalCashDebit}`,
          updatedAt: new Date(),
        })
        .where(eq(balances.did, from_did));

      // Credit each recipient
      for (const recipientDid of recipient_dids) {
        const txId = genId('tx');
        txIds.push(txId);

        const totalGift = cashPerRecipient + creditPerRecipient;

        await tx.insert(transactions).values({
          id: txId,
          service: 'events',
          type: 'event-topup',
          fromDid: from_did,
          toDid: recipientDid,
          amount: totalGift.toString(),
          currency: 'USD',
          status: 'completed',
          source: 'fiat',
          batchId,
          metadata: {
            ...metadata,
            event_id,
            multiplier,
            cash_amount: cashPerRecipient,
            credit_amount: creditPerRecipient,
          },
        });

        await tx
          .insert(balances)
          .values({
            did: recipientDid,
            cashAmount: cashPerRecipient.toString(),
            creditAmount: creditPerRecipient.toString(),
            currency: 'USD',
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: balances.did,
            set: {
              cashAmount: sql`${balances.cashAmount} + ${cashPerRecipient}`,
              creditAmount: sql`${balances.creditAmount} + ${creditPerRecipient}`,
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
        event_id,
        from_did,
        multiplier,
        ticketPrice,
        cashPerRecipient,
        creditPerRecipient,
        totalCashDebit,
        recipientCount: recipient_dids.length,
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Event topup error:', error);
    return NextResponse.json(
      { error: 'Top-up failed' },
      { status: 500, headers: cors }
    );
  }
}
