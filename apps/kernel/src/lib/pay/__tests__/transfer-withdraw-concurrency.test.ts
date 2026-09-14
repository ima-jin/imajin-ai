/**
 * Real two-connection concurrency coverage for the #2166 transfer/withdraw
 * guarded-debit fix.
 *
 * `route.test.ts` for each of `balance/transfer`, `balance/withdraw`, and
 * `balance/withdraw/request` exercises the routes against a hand-rolled fake
 * Drizzle executor (`mock-drizzle-table.ts`) that simulates a real guarded
 * UPDATE's `.returning()` result via a scripted queue. That is the right tool
 * for asserting route-level branching (status codes, rollback evidence,
 * supply-neutrality), but — per the #2165/#2168 review lineage this fix
 * follows — a mock never evaluates a real SQL `WHERE amount >= $x` guard
 * clause under contention; it just returns whatever the test tells it to.
 *
 * This file runs the exact transactional SHAPE each fixed route now uses
 * (`debitUnitIfSufficient` + the route's own follow-up write, inside one
 * `db.transaction()`) against `@electric-sql/pglite` (a real, embedded
 * Postgres engine) via `pglite-pay-harness.ts`, firing two concurrent
 * requests at a balance that can only cover one.
 *
 * IMPORTANT — what this does and does NOT prove: `@electric-sql/pglite` is
 * single-connection/single-transaction under the hood (see the harness's own
 * docblock and https://github.com/electric-sql/pglite/issues/324).
 * `connA`/`connB` are two independent Drizzle handles over that ONE engine,
 * not two truly parallel backends. What this DOES prove is that a real
 * Postgres query planner/executor evaluates the guarded UPDATE's predicate
 * correctly and that two statements issued back-to-back against the same row
 * cannot both match once the balance can no longer cover both — i.e. it
 * proves the guard clause is real SQL that a real engine enforces, not just
 * a string present in a mock's assertion. It does NOT prove true row-lock
 * interleaving behavior under concurrent backends/connections (e.g. that a
 * second real connection blocks on the first's row lock rather than racing
 * it) — that would require a multi-backend engine (e.g. testcontainers),
 * which is deliberately out of scope here (see `pglite-pay-harness.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MJN, creditUnit, debitUnitIfSufficient, InsufficientBalanceError } from '../ledger';
import { createPgliteLedgerHarness, type PgliteLedgerHarness } from './pglite-pay-harness';

vi.mock('@/src/db', async () => {
  const pay = await import('@/src/db/schemas/pay');
  return { db: {}, balances: pay.balances };
});

let harness: PgliteLedgerHarness;

afterEach(async () => {
  await harness?.close();
});

describe('transfer shape (guarded debit + credit in one transaction) — real two-connection concurrency (#2166)', () => {
  it('two concurrent transfers against a balance that covers only one: exactly one succeeds, balance never negative, supply unchanged', async () => {
    harness = await createPgliteLedgerHarness();
    const sender = 'did:imajin:transfer-race-sender';
    const recipient = 'did:imajin:transfer-race-recipient';
    await harness.seedBalance({ did: sender, unit: MJN, amount: 100 });

    async function attemptTransfer(conn: PgliteLedgerHarness['connA']) {
      return conn.transaction(async (tx) => {
        // @ts-expect-error pglite's PgliteDatabase and the app's Executor
        // type both expose the same select/insert/update chain shape at
        // runtime (see ledger-concurrency.test.ts for the same pattern).
        const result = await debitUnitIfSufficient(tx, sender, MJN, 100);
        if (!result.ok) {
          throw new InsufficientBalanceError(MJN);
        }
        // @ts-expect-error same runtime-shape note as above.
        await creditUnit(tx, recipient, MJN, 100, { currency: 'CAD' });
        return 'ok' as const;
      });
    }

    const settled = await Promise.allSettled([
      attemptTransfer(harness.connA),
      attemptTransfer(harness.connB),
    ]);

    const fulfilled = settled.filter((s): s is PromiseFulfilledResult<'ok'> => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(InsufficientBalanceError);

    const senderBalance = await harness.readBalance(harness.connA, sender, MJN);
    const recipientBalance = await harness.readBalance(harness.connA, recipient, MJN);
    expect(senderBalance).toBeGreaterThanOrEqual(0);
    expect(senderBalance).toBe(0);
    // Supply-neutral: exactly what the sender lost, the recipient gained —
    // not double-credited by the loser's rolled-back attempt.
    expect(recipientBalance).toBe(100);
  });
});

describe('withdraw shape (guarded debit reserved before an external side effect) — real two-connection concurrency (#2166)', () => {
  it('two concurrent withdrawals against a balance that covers only one: exactly one reservation succeeds, balance never negative, supply reduced by exactly one withdrawal', async () => {
    harness = await createPgliteLedgerHarness();
    const did = 'did:imajin:withdraw-race';
    await harness.seedBalance({ did, unit: MJN, amount: 50 });

    let externalPayoutCount = 0;

    async function attemptWithdraw(conn: PgliteLedgerHarness['connA']) {
      return conn.transaction(async (tx) => {
        // @ts-expect-error same runtime-shape note as the transfer test above.
        const result = await debitUnitIfSufficient(tx, did, MJN, 50);
        if (!result.ok) {
          throw new InsufficientBalanceError(MJN);
        }
        // Stands in for the real route's Stripe transfer.create call,
        // which #2166 moved inside the transaction AFTER the guarded
        // debit succeeds — the reservation is what a real backing
        // payout is conditioned on, never the other way around.
        externalPayoutCount += 1;
        return 'ok' as const;
      });
    }

    const settled = await Promise.allSettled([
      attemptWithdraw(harness.connA),
      attemptWithdraw(harness.connB),
    ]);

    const fulfilled = settled.filter((s): s is PromiseFulfilledResult<'ok'> => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(InsufficientBalanceError);

    // The external payout only ever fires for the winner — the loser's
    // guard fails before any real money would move.
    expect(externalPayoutCount).toBe(1);

    const finalBalance = await harness.readBalance(harness.connB, did, MJN);
    expect(finalBalance).toBeGreaterThanOrEqual(0);
    expect(finalBalance).toBe(0);
  });
});
