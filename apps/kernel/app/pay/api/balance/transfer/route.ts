/**
 * POST /api/balance/transfer
 *
 * Transfer balance from one DID to another.
 * Auth: sender must be authenticated as from_did.
 * Burns credits first, then cash.
 *
 * #2166: the sender's debit is a single guarded conditional UPDATE
 * (`debitUnitIfSufficient` in `src/lib/pay/ledger.ts`) inside the SAME
 * transaction as the recipient credit, not "read the balance, compare in
 * JS, then unconditionally update" — the latter is a TOCTOU race: two
 * concurrent transfers from the same DID could both read a stale
 * sufficient balance and both proceed, driving the balance negative (an
 * unbacked credit — a mint by another name, #738). Insufficient balance is
 * a 402, never a partial write.
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
import { db, transactions } from '@/src/db';
import { resolveEffectiveDid } from '@imajin/auth';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { MJN, assertKnownUnit, creditUnit, debitUnitIfSufficient, getBalanceRow, InsufficientBalanceError } from '@/src/lib/pay/ledger';

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
    const { from_did, to_did, amount, metadata = {}, unit: rawUnit = MJN } = body;

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

    // #2016: a transfer moves a single wallet unit — no more "burn credit
    // then cash" cascade, and never a cross-unit conversion. Unknown unit is
    // a hard 400, not a fallback.
    const unitCheck = assertKnownUnit(rawUnit);
    if ('error' in unitCheck) {
      return NextResponse.json({ error: unitCheck.error }, { status: unitCheck.status, headers: cors });
    }
    const unit = unitCheck.unit;

    // Currency tag for the transaction/recipient row only — NOT a funding
    // check. Funding sufficiency is enforced atomically inside the
    // transaction below via a guarded conditional UPDATE (see
    // `debitUnitIfSufficient`).
    const senderBalance = await getBalanceRow(db, from_did, unit);
    const transferCurrency = senderBalance?.currency || 'CAD';

    // Check recipient balance currency (if a row already exists for this unit)
    const recipientBalance = await getBalanceRow(db, to_did, unit);
    if (recipientBalance && recipientBalance.currency !== transferCurrency) {
      return NextResponse.json(
        { error: 'Currency mismatch' },
        { status: 400, headers: cors }
      );
    }

    // Source label mirrors the unit 1:1 now that there is no mixed burn.
    const source: 'credit' | 'fiat' = unit === MJN ? 'fiat' : 'credit';

    const txId = generateId('tx');

    // Atomic operation: guarded debit sender, credit recipient, log
    // transaction — both legs touch the SAME unit row, so cross-unit
    // movement is impossible by construction (#2016 decision 2). The debit
    // is a single guarded conditional UPDATE (#2166) — insufficient balance
    // throws `InsufficientBalanceError` before the recipient is credited or
    // the transaction row is inserted, rolling back this whole transaction.
    try {
      await db.transaction(async (tx) => {
        const debitResult = await debitUnitIfSufficient(tx, from_did, unit, amount);
        if (!debitResult.ok) {
          throw new InsufficientBalanceError(unit);
        }

        await tx.insert(transactions).values({
          id: txId,
          service: 'transfer',
          type: 'transfer',
          fromDid: from_did,
          toDid: to_did,
          amount: amount.toString(),
          currency: transferCurrency,
          unit,
          sourceKind: 'transfer',
          status: 'completed',
          source,
          metadata,
        });

        await creditUnit(tx, to_did, unit, amount, { currency: transferCurrency });
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
        transactionId: txId,
        from_did,
        to_did,
        amount,
        unit,
        source,
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Transfer error');
    return NextResponse.json(
      { error: 'Transfer failed' },
      { status: 500, headers: cors }
    );
  }
});
