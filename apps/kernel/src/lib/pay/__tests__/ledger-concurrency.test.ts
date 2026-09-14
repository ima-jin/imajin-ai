/**
 * Real two-connection concurrency coverage for the ledger debit guard (#2168).
 *
 * `ledger.test.ts` exercises `debitUnitIfSufficient` / `debitFundedLegs` against
 * a hand-rolled fake Drizzle executor. Per the #2165 round-2 review, that proves
 * the `WHERE amount >= $x` guard clause is *present* in the generated query,
 * never that a real Postgres engine *enforces* it under contention — the mock
 * never evaluates the clause, so deleting it would leave every mock-based test
 * green. This file runs the same functions against `@electric-sql/pglite` (a
 * real, embedded Postgres engine) via `pglite-pay-harness.ts`, and fires two
 * concurrent debits against a balance that can only cover one.
 *
 * `debitUnitIfSufficient` / `debitFundedLegs` / `InsufficientBalanceError` are
 * added to `../ledger` by #2165 (open, not yet merged, as of this writing) —
 * see that PR's branch (`fix/2018-gift-topup-funded-transfers`) for the guard
 * shape this suite is written against. Rather than a static named import that
 * would fail typecheck on `main` until #2165 merges, this file feature-detects
 * those exports on the `../ledger` namespace so the suite activates
 * automatically post-merge without narrowing this PR's scope or requiring a
 * rebase before it can land. See #2168's "note the dependency" instruction.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as ledgerNamespace from '../ledger';
import { MJN } from '../ledger';
import { createPgliteLedgerHarness, type PgliteLedgerHarness } from './pglite-pay-harness';

// Matches ledger.test.ts's existing mock: `ledger.ts` imports `{ db, balances }`
// from `@/src/db`, whose barrel eagerly calls `createDb()` (and therefore
// requires `DATABASE_URL`) at module-eval time. `db` is never used directly by
// the functions under test here — they only ever operate on the `executor`
// argument — so it's mocked to an empty object. `balances` must be the REAL
// `pgTable` definition (not a plain object) so pglite's Drizzle connections can
// build real SQL against it.
vi.mock('@/src/db', async () => {
  const pay = await import('@/src/db/schemas/pay');
  return { db: {}, balances: pay.balances };
});

/**
 * Local, deliberately loose view of the guard primitives #2165 adds to
 * `../ledger`. `executor` is typed `unknown` here (not the real `Executor`
 * type) so this file never has to reconcile pglite's `PgliteDatabase` generic
 * with the app's `PostgresJsDatabase`-based `Executor` — at runtime both just
 * need to expose the same `select`/`insert`/`update` chain shape, which they do.
 */
interface LedgerDebitGuardExports {
  debitUnitIfSufficient: (
    executor: unknown,
    did: string,
    unit: string,
    amount: number | string,
  ) => Promise<{ ok: boolean; row?: { amount: string } }>;
  debitFundedLegs: (
    executor: unknown,
    did: string,
    legs: ReadonlyArray<{ unit: string; amount: number }>,
  ) => Promise<void>;
  InsufficientBalanceError: new (unit: string) => Error;
}

const ledger = ledgerNamespace as unknown as Partial<LedgerDebitGuardExports>;
const hasGuardedDebit = typeof ledger.debitUnitIfSufficient === 'function' && typeof ledger.debitFundedLegs === 'function';

// #2165 not merged as of this writing — see the file docblock. Once it lands,
// `hasGuardedDebit` flips to true and this suite runs for real.
describe.skipIf(!hasGuardedDebit)(
  'debitUnitIfSufficient / debitFundedLegs — real two-connection concurrency (#2168, depends on #2165)',
  () => {
    let harness: PgliteLedgerHarness;

    beforeAll(async () => {
      harness = await createPgliteLedgerHarness();
    });

    afterAll(async () => {
      await harness.close();
    });

    it('exactly one of two concurrent debitUnitIfSufficient calls succeeds against a balance that covers only one', async () => {
      const did = 'did:imajin:concurrency-unit-guard';
      await harness.seedBalance({ did, unit: MJN, amount: 100 });

      const [resultA, resultB] = await Promise.all([
        ledger.debitUnitIfSufficient!(harness.connA, did, MJN, 100),
        ledger.debitUnitIfSufficient!(harness.connB, did, MJN, 100),
      ]);

      const oks = [resultA.ok, resultB.ok];
      expect(oks.filter((ok) => ok)).toHaveLength(1);
      expect(oks.filter((ok) => !ok)).toHaveLength(1);

      // Final balance is conserved exactly: one 100-unit debit landed, not
      // zero (both wrongly rejected) and not two (the pre-#2165 TOCTOU race,
      // which would drive this negative).
      const finalBalance = await harness.readBalance(harness.connA, did, MJN);
      expect(finalBalance).toBeGreaterThanOrEqual(0);
      expect(finalBalance).toBe(0);
    });

    it('exactly one of two concurrent debitFundedLegs calls succeeds — the loser throws InsufficientBalanceError', async () => {
      const did = 'did:imajin:concurrency-funded-legs';
      await harness.seedBalance({ did, unit: MJN, amount: 50 });

      const settled = await Promise.allSettled([
        ledger.debitFundedLegs!(harness.connA, did, [{ unit: MJN, amount: 50 }]),
        ledger.debitFundedLegs!(harness.connB, did, [{ unit: MJN, amount: 50 }]),
      ]);

      const fulfilled = settled.filter((s): s is PromiseFulfilledResult<void> => s.status === 'fulfilled');
      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ledger.InsufficientBalanceError);

      const finalBalance = await harness.readBalance(harness.connB, did, MJN);
      expect(finalBalance).toBeGreaterThanOrEqual(0);
      expect(finalBalance).toBe(0);
    });

    it('two connections read and write through the same real balances row (sanity: not two independent in-memory DBs)', async () => {
      const did = 'did:imajin:concurrency-cross-connection';
      await harness.seedBalance({ did, unit: MJN, amount: 10 });

      // Debit fully via connA; the effect must be visible reading through connB.
      const result = await ledger.debitUnitIfSufficient!(harness.connA, did, MJN, 10);
      expect(result.ok).toBe(true);

      const viaB = await harness.readBalance(harness.connB, did, MJN);
      expect(viaB).toBe(0);
    });
  },
);

describe('createPgliteLedgerHarness (reusable helper)', () => {
  let harness: PgliteLedgerHarness;

  beforeAll(async () => {
    harness = await createPgliteLedgerHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('applies the pay-relevant migrations and exposes two connections over one real balances table', async () => {
    const did = 'did:imajin:harness-smoke';
    await harness.seedBalance({ did, unit: MJN, amount: 42, currency: 'CAD' });

    const viaA = await harness.readBalance(harness.connA, did, MJN);
    const viaB = await harness.readBalance(harness.connB, did, MJN);
    expect(viaA).toBe(42);
    expect(viaB).toBe(42);
  });

  it('readBalance returns 0 for a (did, unit) row that was never seeded', async () => {
    const balance = await harness.readBalance(harness.connA, 'did:imajin:never-seeded', MJN);
    expect(balance).toBe(0);
  });
});
