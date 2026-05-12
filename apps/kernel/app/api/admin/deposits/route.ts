import { NextRequest, NextResponse } from 'next/server';
import { db, balances, transactions } from '@/src/db';
import { sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { requireAdmin } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as {
      did: string;
      amount: number;
      currency?: string;
      memo?: string;
    };

    const { did, amount, currency = 'CAD', memo } = body;

    if (!did || !amount) {
      return NextResponse.json(
        { error: 'Missing required fields: did, amount' },
        { status: 400 }
      );
    }

    if (amount <= 0) {
      return NextResponse.json(
        { error: 'Amount must be positive' },
        { status: 400 }
      );
    }

    // Verify DID exists
    const identityRow = await db.query.identities.findFirst({
      where: (identities, { eq }) => eq(identities.id, did),
    });

    if (!identityRow) {
      return NextResponse.json(
        { error: 'Identity not found' },
        { status: 404 }
      );
    }

    const txId = generateId('tx');
    const metadata: Record<string, unknown> = {
      adminDid: session.actingAs,
    };
    if (memo) metadata.memo = memo;

    // Atomic operation: insert transaction + update cash balance
    await db.transaction(async (tx) => {
      await tx.insert(transactions).values({
        id: txId,
        service: 'emt',
        type: 'topup',
        fromDid: null,
        toDid: did,
        amount: amount.toString(),
        currency,
        status: 'completed',
        source: 'fiat',
        metadata,
      });

      await tx
        .insert(balances)
        .values({
          did,
          cashAmount: amount.toString(),
          creditAmount: '0',
          currency,
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

    log.info(
      { did, amount, currency, txId, adminDid: session.actingAs },
      'Admin deposit credited'
    );

    return NextResponse.json({
      success: true,
      transactionId: txId,
      did,
      amount,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Admin deposit error');
    return NextResponse.json(
      { error: 'Deposit failed' },
      { status: 500 }
    );
  }
});
