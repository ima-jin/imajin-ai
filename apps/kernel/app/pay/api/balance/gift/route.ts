/**
 * POST /api/balance/gift
 *
 * Bulk gift credits from a business DID to recipients.
 * Auth: from_did must match session.
 *
 * #2018: this is a FUNDED TRANSFER, never a mint — any entity outside the
 * kernel that credits MJNx funds it. `from_did` is debited in both units:
 * its MJN (cash) balance for the total gifted `cash_amount`, and its MJNx
 * balance for the total gifted `credit_amount`. Both legs are credited to
 * recipients atomically in the same transaction as the debits. Insufficient
 * balance in either unit is a 402, never a partial mint.
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
import { and, eq, sql } from 'drizzle-orm';
import { resolveEffectiveDid } from '@imajin/auth';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { MJN, MJNX, amountOf, creditUnit, debitUnit, getBalanceRow } from '@/src/lib/pay/ledger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const auth = await resolveEffectiveDid(request, { scope: 'wallet:write' });
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status, headers: cors }
      );
    }
    const effectiveDid = auth.effectiveDid;

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

    // Total amount deducted from from_did per unit is the sum of all gifts.
    const totalCashDebit = recipients.reduce((sum: number, r: { cash_amount?: number }) => sum + (r.cash_amount ?? 0), 0);
    const totalCreditDebit = recipients.reduce((sum: number, r: { credit_amount?: number }) => sum + (r.credit_amount ?? 0), 0);

    // #2018: any entity outside the kernel that credits MJNx funds it. Both
    // legs are funded transfers, so from_did must have sufficient balance in
    // BOTH units before anything is written — insufficient balance is a 402,
    // never a mint.
    const senderCashBalance = await getBalanceRow(db, from_did, MJN);
    const currentCash = amountOf(senderCashBalance);
    const giftCurrency = senderCashBalance?.currency || 'CAD';

    if (currentCash < totalCashDebit) {
      return NextResponse.json(
        { error: `Insufficient MJN balance: ${currentCash} < ${totalCashDebit}` },
        { status: 402, headers: cors }
      );
    }

    const senderCreditBalance = await getBalanceRow(db, from_did, MJNX);
    const currentCredit = amountOf(senderCreditBalance);

    if (currentCredit < totalCreditDebit) {
      return NextResponse.json(
        { error: `Insufficient MJNx balance: ${currentCredit} < ${totalCreditDebit}` },
        { status: 402, headers: cors }
      );
    }

    const batchId = generateId('batch');
    const txIds: string[] = [];

    await db.transaction(async (tx) => {
      // Debit from_did's MJN cash
      if (totalCashDebit > 0) {
        await tx
          .update(balances)
          .set({
            amount: sql`${balances.amount} - ${totalCashDebit}`,
            updatedAt: new Date(),
          })
          .where(and(eq(balances.did, from_did), eq(balances.unit, MJN)));
      }

      // Debit from_did's MJNx credits (#2018: the credit leg is now a funded
      // transfer, not an unbacked mint — the business's MJNx balance decreases
      // by exactly what recipients receive).
      if (totalCreditDebit > 0) {
        await debitUnit(tx, from_did, MJNX, totalCreditDebit);
      }

      // Credit each recipient. #2016: the cash leg and credit leg now land
      // on separate per-unit balance rows (MJN / MJNx), so each nonzero leg
      // gets its own transaction row instead of one row spanning both
      // buckets.
      for (const recipient of recipients) {
        const cashGift = recipient.cash_amount ?? 0;
        const creditGift = recipient.credit_amount ?? 0;

        if (cashGift === 0 && creditGift === 0) continue;

        if (cashGift > 0) {
          const txId = generateId('tx');
          txIds.push(txId);
          await tx.insert(transactions).values({
            id: txId,
            service: 'gift',
            type: 'gift',
            fromDid: from_did,
            toDid: recipient.did,
            amount: cashGift.toString(),
            currency: giftCurrency,
            unit: MJN,
            sourceKind: 'transfer',
            status: 'completed',
            source: 'fiat',
            batchId,
            metadata: { ...metadata, cash_amount: cashGift, credit_amount: creditGift },
          });
          await creditUnit(tx, recipient.did, MJN, cashGift, { currency: giftCurrency });
        }

        if (creditGift > 0) {
          const txId = generateId('tx');
          txIds.push(txId);
          await tx.insert(transactions).values({
            id: txId,
            service: 'gift',
            type: 'gift',
            fromDid: from_did,
            toDid: recipient.did,
            amount: creditGift.toString(),
            currency: giftCurrency,
            unit: MJNX,
            sourceKind: 'transfer',
            status: 'completed',
            source: 'credit',
            batchId,
            metadata: { ...metadata, cash_amount: cashGift, credit_amount: creditGift },
          });
          await creditUnit(tx, recipient.did, MJNX, creditGift, { currency: giftCurrency });
        }
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
    log.error({ err: String(error) }, 'Gift error');
    return NextResponse.json(
      { error: 'Gift operation failed' },
      { status: 500, headers: cors }
    );
  }
});
