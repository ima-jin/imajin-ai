/**
 * Real-engine coverage for the withdrawal-intent reserve/confirm/release
 * flow (#2172), via `createPgliteLedgerHarness()` (#2168).
 *
 * IMPORTANT — what this proves and does NOT prove: `@electric-sql/pglite`
 * is single-connection/single-transaction under the hood (see the
 * harness's own docblock). This is real-Postgres GUARD EVALUATION — the
 * guarded `debitUnitIfSufficient` UPDATE really does refuse an
 * over-withdrawal against a real engine, and the intent row really is
 * only ever visible once its inserting transaction commits — NOT
 * multi-connection RACE coverage. That concurrency proof already exists
 * for the underlying guarded-debit primitive in
 * `transfer-withdraw-concurrency.test.ts`; this file is the extension of
 * that same harness to the intent table added on top of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { MJN, InsufficientBalanceError } from '../ledger';
import { withdrawalIntents } from '@/src/db/schemas/pay';
import { createPgliteLedgerHarness, type PgliteLedgerHarness } from './pglite-pay-harness';

vi.mock('@/src/db', async () => {
  const pay = await import('@/src/db/schemas/pay');
  return { db: {}, balances: pay.balances, transactions: pay.transactions, withdrawalIntents: pay.withdrawalIntents };
});

let harness: PgliteLedgerHarness;

afterEach(async () => {
  await harness?.close();
});

/** Mirrors `reserveWithdrawal`'s transactional shape directly against the harness connection (the module itself uses the app's shared `db`, which this harness doesn't stand in for — see `transfer-withdraw-concurrency.test.ts` for the same pattern). */
async function reserveAgainstHarness(conn: PgliteLedgerHarness['connA'], did: string, amount: number, id: string) {
  const { debitUnitIfSufficient } = await import('../ledger');
  return conn.transaction(async (tx) => {
    // @ts-expect-error pglite's PgliteDatabase and the app's Executor type expose the same select/insert/update chain shape at runtime.
    const result = await debitUnitIfSufficient(tx, did, MJN, amount);
    if (!result.ok) throw new InsufficientBalanceError(MJN);
    // @ts-expect-error same runtime-shape note as above.
    await tx.insert(withdrawalIntents).values({ id, did, unit: MJN, amount: String(amount), rail: 'fake', idempotencyKey: id, status: 'pending' });
    return id;
  });
}

describe('withdrawal intent reservation — real engine guard evaluation (#2172, pglite)', () => {
  it('the guarded debit and the intent insert commit together: insufficient balance leaves no intent row at all', async () => {
    harness = await createPgliteLedgerHarness();
    const did = 'did:imajin:pglite-withdraw';
    await harness.seedBalance({ did, unit: MJN, amount: 10 });

    await expect(reserveAgainstHarness(harness.connA, did, 999, 'wdi_pglite_1')).rejects.toBeInstanceOf(InsufficientBalanceError);

    const balance = await harness.readBalance(harness.connA, did, MJN);
    expect(balance).toBe(10); // untouched — the whole transaction rolled back

    const rows = await harness.connA.select().from(withdrawalIntents).where(eq(withdrawalIntents.id, 'wdi_pglite_1'));
    expect(rows).toHaveLength(0);
  });

  it('a sufficient reservation commits both the debit and the durable pending intent row', async () => {
    harness = await createPgliteLedgerHarness();
    const did = 'did:imajin:pglite-withdraw-2';
    await harness.seedBalance({ did, unit: MJN, amount: 50 });

    await reserveAgainstHarness(harness.connA, did, 20, 'wdi_pglite_2');

    const balance = await harness.readBalance(harness.connB, did, MJN);
    expect(balance).toBe(30);

    const [row] = await harness.connB.select().from(withdrawalIntents).where(eq(withdrawalIntents.id, 'wdi_pglite_2'));
    expect(row).toMatchObject({ did, unit: MJN, amount: '20.00000000', status: 'pending', idempotencyKey: 'wdi_pglite_2' });
  });
});
