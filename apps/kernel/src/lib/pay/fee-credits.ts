import { sql } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, transactions, balanceRollups } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { creditUnit, type Unit } from './ledger';

const log = createLogger('pay:fee');

interface FeeCreditIdentity {
  transactionId: string;
  role: string;
  recipientDid: string;
  /** Absolute manifest position: caller-supplied chains may repeat a role/DID. */
  chainIndex?: number;
}

/** Payment/manifest identity only: shared by webhook retries and fee receipt replay. */
export function feeCreditKey({ transactionId, role, recipientDid, chainIndex }: FeeCreditIdentity): string {
  const key = `fee:${transactionId}:${role}:${recipientDid}`;
  return chainIndex === undefined ? key : `${key}:${chainIndex}`;
}

interface FeeCreditParams extends FeeCreditIdentity {
  service?: string | null;
  amountCents: number;
  currency: string;
  unit: Unit;
  /** Only chain distributions had rollups before fee deduplication. */
  rollup?: boolean;
}

/** Claim, wallet delta and optional daily rollup commit together or not at all. */
export async function applyFeeCredit(params: FeeCreditParams): Promise<void> {
  const { transactionId, role, recipientDid, amountCents, currency, unit, rollup } = params;
  const key = feeCreditKey(params);
  const amount = (amountCents / 100).toFixed(8);
  const service = params.service || 'unknown';

  await db.transaction(async (tx) => {
    const claimed = await tx.insert(transactions).values({
      id: generateId('tx'),
      service,
      type: 'fee',
      fromDid: null,
      toDid: recipientDid,
      amount,
      currency,
      unit,
      sourceKind: 'fee',
      source: 'fee',
      status: 'completed',
      idempotencyKey: key,
      metadata: { role, transactionId, feeCreditKey: key },
    }).onConflictDoNothing().returning({ id: transactions.id });
    if (claimed.length === 0) {
      log.info({ feeCreditKey: key }, '[fee] duplicate wallet effect ignored');
      return;
    }

    await creditUnit(tx, recipientDid, unit, amount, { currency });
    if (!rollup) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await tx.insert(balanceRollups).values({
      did: recipientDid,
      date: today,
      service,
      earned: amount,
      spent: '0',
      txCount: 1,
    }).onConflictDoUpdate({
      target: [balanceRollups.did, balanceRollups.date, balanceRollups.service],
      set: {
        earned: sql`${balanceRollups.earned} + ${amount}`,
        txCount: sql`${balanceRollups.txCount} + 1`,
      },
    });
  });
}
