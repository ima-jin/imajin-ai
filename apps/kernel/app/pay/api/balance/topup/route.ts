/**
 * POST /api/balance/topup
 *
 * Credit the session user's cash balance. No service credential is accepted.
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
import { db, transactions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { MJN, creditUnit } from '@/src/lib/pay/ledger';
import { requireAuth, resolveActingDid } from '@imajin/auth';

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const auth = await requireAuth(request, { sessionOnly: true, service: 'pay' });
    if ('error' in auth) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status, headers: cors }
      );
    }

    const body = await request.json();
    const { did, amount, service, type, metadata = {}, currency = 'CAD' } = body;

    if (!did || !amount || !service || !type) {
      return NextResponse.json(
        { error: 'Missing required fields: did, amount, service, type' },
        { status: 400, headers: cors }
      );
    }

    if (did !== resolveActingDid(auth.identity)) {
      return NextResponse.json(
        { error: 'Forbidden - topup is limited to the session identity' },
        { status: 403, headers: cors }
      );
    }

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: 'Amount must be positive' },
        { status: 400, headers: cors }
      );
    }

    const txId = generateId('tx');

    // Atomic operation: insert transaction + credit MJN balance (real money)
    await db.transaction(async (tx) => {
      // Insert transaction
      await tx.insert(transactions).values({
        id: txId,
        service,
        type,
        fromDid: null, // topup has no from_did
        toDid: did,
        amount: amount.toString(),
        currency,
        unit: MJN,
        sourceKind: 'receipt',
        status: 'completed',
        source: 'fiat',
        metadata,
      });

      await creditUnit(tx, did, MJN, amount, { currency });
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
    log.error({ err: String(error) }, 'Topup error');
    return NextResponse.json(
      { error: 'Top-up failed' },
      { status: 500, headers: cors }
    );
  }
});
