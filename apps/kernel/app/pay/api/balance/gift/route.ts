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
 * Each debit is a single guarded conditional UPDATE (`debitFundedLegs` in
 * `src/lib/pay/ledger.ts`), not "read the balance, compare in JS, then
 * unconditionally update" — the latter is a TOCTOU race: two concurrent
 * gifts from the same business could both read a stale sufficient balance
 * and both proceed, driving the balance negative (an unbacked mint).
 *
 * Request:
 * {
 *   from_did: string,
 *   recipients: Array<{ did: string, cash_amount: number, credit_amount: number }>,
 *   metadata?: Record<string, any>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, transactions } from '@/src/db';
import { resolveEffectiveDid } from '@imajin/auth';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { MJN, MJNX, creditUnit, debitFundedLegs, getBalanceRow, InsufficientBalanceError } from '@/src/lib/pay/ledger';

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

    // Currency tag for recipient rows only — NOT a funding check. Funding
    // sufficiency is enforced atomically inside the transaction below via a
    // guarded conditional UPDATE per unit (see `debitFundedLegs`).
    const senderBalance = await getBalanceRow(db, from_did, MJN);
    const giftCurrency = senderBalance?.currency || 'CAD';

    const batchId = generateId('batch');
    const txIds: string[] = [];

    try {
      await db.transaction(async (tx) => {
        // #2018: any entity outside the kernel that credits MJNx funds it.
        // Each nonzero leg is debited via its own guarded conditional UPDATE
        // (`debitUnitIfSufficient`) — insufficient balance throws
        // `InsufficientBalanceError` here, before any recipient is credited,
        // rolling back this whole transaction (including an already-succeeded
        // MJN debit if the MJNx leg is the one that fails).
        await debitFundedLegs(tx, from_did, [
          { unit: MJN, amount: totalCashDebit },
          { unit: MJNX, amount: totalCreditDebit },
        ]);

        // Credit each recipient. #2016: the cash leg and credit leg land on
        // separate per-unit balance rows (MJN / MJNx), so each nonzero leg
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
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return NextResponse.json({ error: err.message }, { status: 402, headers: cors });
      }
      throw err;
    }

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
