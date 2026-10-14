import { and, eq } from 'drizzle-orm';
import { db, transactions } from '@/src/db';
import { getNodeDidFromConfig } from '@/src/lib/kernel/node-identity';
import { creditUnit, MJN } from './ledger';
import type { SettleByoCheckoutInput } from './byo-checkout-settlement';

/**
 * The node is the seller for topups. Never trust a different connector owner's
 * event or mint from webhook metadata: credit the amount recorded at checkout.
 * The guarded completion and credit commit together, so retries cannot double-mint.
 */
export async function settleNodeTopupFromStripe(input: SettleByoCheckoutInput): Promise<boolean> {
  const nodeDid = await getNodeDidFromConfig();
  if (!nodeDid || input.ownerDid !== nodeDid) return false;

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(transactions).where(and(
      eq(transactions.id, input.transactionId),
      eq(transactions.rail, 'stripe'),
      eq(transactions.service, 'topup'),
      eq(transactions.type, 'topup'),
    )).limit(1);
    if (!row || row.status !== 'pending') return false;

    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const topupAmount = Number(row.amount);
    const chargeAmount = Number(metadata.chargeAmountCents);
    if (
      metadata.nodeDid !== nodeDid || !row.toDid || row.toDid !== row.fromDid ||
      !Number.isFinite(topupAmount) || topupAmount <= 0 ||
      !Number.isSafeInteger(chargeAmount) || chargeAmount < Math.round(topupAmount * 100) ||
      input.amount !== chargeAmount || input.currency !== row.currency.toUpperCase()
    ) return false;

    const [completed] = await tx.update(transactions).set({
      status: 'completed',
      unit: MJN,
      sourceKind: 'receipt',
      metadata: { ...metadata, paymentIntentId: input.paymentIntentId },
    }).where(and(eq(transactions.id, row.id), eq(transactions.status, 'pending')))
      .returning({ id: transactions.id });
    if (!completed) return false;

    await creditUnit(tx, row.toDid, MJN, row.amount, { currency: row.currency });
    return true;
  });
}
