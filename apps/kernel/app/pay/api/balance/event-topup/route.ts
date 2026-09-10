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
import { and, eq, sql } from 'drizzle-orm';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { MJN, MJNX, amountOf, creditUnit, getBalanceRow } from '@/src/lib/pay/ledger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: cors }
      );
    }

    const effectiveDid = resolveActingDid(authResult.identity);

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

    // Check from_did has sufficient MJN cash — only the cash (refund) leg is
    // ever debited from the sender, matching pre-#2016 behavior; making this
    // a real funded transfer is #2018, out of scope here.
    const senderBalance = await getBalanceRow(db, from_did, MJN);
    const currentCash = amountOf(senderBalance);
    const topupCurrency = senderBalance?.currency || 'CAD';

    if (currentCash < totalCashDebit) {
      return NextResponse.json(
        { error: `Insufficient cash balance: ${currentCash} < ${totalCashDebit}` },
        { status: 400, headers: cors }
      );
    }

    const batchId = generateId('batch');
    const txIds: string[] = [];

    await db.transaction(async (tx) => {
      // Debit from_did's MJN cash
      await tx
        .update(balances)
        .set({
          amount: sql`${balances.amount} - ${totalCashDebit}`,
          updatedAt: new Date(),
        })
        .where(and(eq(balances.did, from_did), eq(balances.unit, MJN)));

      // Credit each recipient. #2016: the cash (refund) leg and credit
      // (bonus) leg now land on separate per-unit balance rows (MJN / MJNx),
      // so each nonzero leg gets its own transaction row instead of one row
      // spanning both buckets — a mechanical adaptation, not a policy change.
      for (const recipientDid of recipient_dids) {
        if (cashPerRecipient > 0) {
          const txId = generateId('tx');
          txIds.push(txId);
          await tx.insert(transactions).values({
            id: txId,
            service: 'events',
            type: 'event-topup',
            fromDid: from_did,
            toDid: recipientDid,
            amount: cashPerRecipient.toString(),
            currency: topupCurrency,
            unit: MJN,
            sourceKind: 'transfer',
            status: 'completed',
            source: 'fiat',
            batchId,
            metadata: { ...metadata, event_id, multiplier, cash_amount: cashPerRecipient, credit_amount: creditPerRecipient },
          });
          await creditUnit(tx, recipientDid, MJN, cashPerRecipient, { currency: topupCurrency });
        }

        if (creditPerRecipient > 0) {
          const txId = generateId('tx');
          txIds.push(txId);
          await tx.insert(transactions).values({
            id: txId,
            service: 'events',
            type: 'event-topup',
            fromDid: from_did,
            toDid: recipientDid,
            amount: creditPerRecipient.toString(),
            currency: topupCurrency,
            unit: MJNX,
            sourceKind: 'transfer',
            status: 'completed',
            source: 'credit',
            batchId,
            metadata: { ...metadata, event_id, multiplier, cash_amount: cashPerRecipient, credit_amount: creditPerRecipient },
          });
          await creditUnit(tx, recipientDid, MJNX, creditPerRecipient, { currency: topupCurrency });
        }
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
    log.error({ err: String(error) }, 'Event topup error');
    return NextResponse.json(
      { error: 'Top-up failed' },
      { status: 500, headers: cors }
    );
  }
});
