import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { db, balances, transactions } from '@/src/db';
import { sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';

const pgSql = getClient();

/**
 * GET /api/admin/deposits
 * List recent fiat topup transactions.
 */
export async function GET() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rows = await pgSql`
    SELECT id, to_did, amount, currency, metadata, created_at
    FROM pay.transactions
    WHERE type = 'topup' AND source = 'fiat'
    ORDER BY created_at DESC
    LIMIT 20
  `;

  return NextResponse.json({ deposits: rows });
}

/**
 * POST /api/admin/deposits
 * Record a manual EMT deposit — credits the target DID's cash balance.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { did, amount, currency = 'CAD', memo = '' } = body;

  if (!did || typeof did !== 'string') {
    return NextResponse.json({ error: 'did is required' }, { status: 400 });
  }
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 });
  }

  const txId = generateId('tx');

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
      metadata: { memo, adminDid: session.actingAs },
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

  return NextResponse.json({ success: true, transactionId: txId });
}
