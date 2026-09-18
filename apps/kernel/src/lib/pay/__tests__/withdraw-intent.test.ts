/**
 * Unit tests for `withdraw-intent.ts` (#2172) against a hand-rolled fake
 * Drizzle executor, dispatching by REAL table object identity (`pay.balances`
 * / `pay.withdrawalIntents` / `pay.transactions`) rather than a `__table`
 * string tag — this file exercises three tables at once, unlike the
 * single-table fakes elsewhere in this suite. `debitUnitIfSufficient`'s own
 * guard-predicate SQL is already covered by `ledger.test.ts`'s
 * `PgDialect().sqlToQuery()` assertions; this file scripts its
 * `.returning()` result (sufficient/insufficient) rather than re-deriving it,
 * the same convention `mock-drizzle-table.ts`'s route suites use.
 *
 * Every test uses `FakeRail` (`./fake-rail.ts`) — never a Stripe type —
 * proving this module's crash-injection/retry-idempotency behavior holds
 * for the `WithdrawRail` interface generically, not for Stripe specifically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  balanceReturningQueue: [] as Array<Record<string, unknown>[]>,
  intentRows: [] as Record<string, unknown>[],
  insertedIntents: [] as Record<string, unknown>[],
  updatedIntents: [] as Array<{ values: Record<string, unknown> }>,
  insertedTransactions: [] as Record<string, unknown>[],
  creditCalls: [] as Array<{ did: string; unit: string; amount: unknown }>,
}));

vi.mock('@/src/db', async () => {
  const pay = await import('@/src/db/schemas/pay');

  function guardedUpdateResult(rows: Record<string, unknown>[]) {
    return Object.assign(Promise.resolve(undefined), { returning: () => Promise.resolve(rows) });
  }

  function makeExecutor() {
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            Object.assign(Promise.resolve(table === pay.withdrawalIntents ? state.intentRows : []), {
              limit: (_n: number) => Promise.resolve(table === pay.withdrawalIntents ? state.intentRows : []),
            }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          if (table === pay.withdrawalIntents) state.insertedIntents.push(values);
          if (table === pay.transactions) state.insertedTransactions.push(values);
          const promise = Promise.resolve(undefined);
          return Object.assign(promise, { onConflictDoUpdate: () => Promise.resolve(undefined) });
        },
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            if (table === pay.balances) {
              return guardedUpdateResult(state.balanceReturningQueue.shift() ?? [{}]);
            }
            if (table === pay.withdrawalIntents) {
              state.updatedIntents.push({ values });
              // Mirror the update into intentRows so a later select (e.g.
              // confirmWithdrawalFromRailEvent's idempotency check) sees it.
              for (const row of state.intentRows) Object.assign(row, values);
            }
            return guardedUpdateResult([{}]);
          },
        }),
      }),
    };
  }

  const executor = makeExecutor();
  return {
    db: { ...executor, transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(executor) },
    balances: pay.balances,
    transactions: pay.transactions,
    withdrawalIntents: pay.withdrawalIntents,
  };
});

vi.mock('../ledger', async () => {
  const actual = await vi.importActual<typeof import('../ledger')>('../ledger');
  return {
    ...actual,
    creditUnit: vi.fn(async (_tx: unknown, did: string, unit: string, amount: unknown) => {
      state.creditCalls.push({ did, unit, amount });
    }),
  };
});

vi.mock('@/src/lib/kernel/id', () => {
  let seq = 0;
  return { generateId: (prefix: string) => `${prefix}_test_${++seq}` };
});

// `withdraw-intent.ts` calls `emitReconciliationDiscrepancy` when a late
// webhook reports completion for an already-released/failed intent —
// mocked here so these tests assert on the call rather than exercising
// reconciliation.ts's own DB-backed dedup logic (covered by
// `reconciliation.test.ts`).
const { emitReconciliationDiscrepancyMock } = vi.hoisted(() => ({
  emitReconciliationDiscrepancyMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../reconciliation', () => ({
  emitReconciliationDiscrepancy: emitReconciliationDiscrepancyMock,
}));

import { reserveWithdrawal, confirmWithdrawal, releaseWithdrawal, executeWithdrawal, confirmWithdrawalFromRailEvent } from '../withdraw-intent';
import { InsufficientBalanceError, MJN } from '../ledger';
import { creditUnit } from '../ledger';
import { FakeRail } from './fake-rail';

const DID = 'did:imajin:withdraw-test';

function resetState() {
  state.balanceReturningQueue.length = 0;
  state.intentRows.length = 0;
  state.insertedIntents.length = 0;
  state.updatedIntents.length = 0;
  state.insertedTransactions.length = 0;
  state.creditCalls.length = 0;
  emitReconciliationDiscrepancyMock.mockClear();
}

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
});

describe('reserveWithdrawal', () => {
  it('inserts a pending intent whose idempotencyKey equals its id when the guarded debit succeeds', async () => {
    state.balanceReturningQueue.push([{ did: DID, unit: MJN, amount: '95' }]);

    const intent = await reserveWithdrawal({ did: DID, unit: MJN, amount: 5, rail: 'fake' });

    expect(intent.idempotencyKey).toBe(intent.id);
    expect(state.insertedIntents).toHaveLength(1);
    expect(state.insertedIntents[0]).toMatchObject({ did: DID, unit: MJN, amount: '5', rail: 'fake', status: 'pending' });
  });

  it('throws InsufficientBalanceError and inserts nothing when the guarded debit fails', async () => {
    state.balanceReturningQueue.push([]); // guard: zero rows matched

    await expect(reserveWithdrawal({ did: DID, unit: MJN, amount: 999, rail: 'fake' })).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
    expect(state.insertedIntents).toHaveLength(0);
  });
});

describe('confirmWithdrawal', () => {
  it('marks the intent completed and records a receipt-kind transaction with the external ref', async () => {
    const intent = { id: 'wdi_1', did: DID, unit: MJN, amount: '5', rail: 'fake', idempotencyKey: 'wdi_1', destination: 'acct_1', currency: 'CAD' };

    const txId = await confirmWithdrawal(intent, 'fake_tr_1');

    expect(state.updatedIntents[0].values).toMatchObject({ status: 'completed', externalRef: 'fake_tr_1' });
    expect(state.insertedTransactions[0]).toMatchObject({
      id: txId,
      type: 'withdrawal',
      sourceKind: 'receipt',
      status: 'completed',
      stripeId: 'fake_tr_1',
      toDid: 'acct_1',
      metadata: { rail: 'fake', externalRef: 'fake_tr_1', intentId: 'wdi_1' },
    });
  });
});

describe('releaseWithdrawal (#2172: reservation release, recorded like every other balance mutation)', () => {
  it('marks the intent failed, credits the balance back, and records a withdrawal_release transaction', async () => {
    const intent = { id: 'wdi_2', did: DID, unit: MJN, amount: '5', rail: 'fake', idempotencyKey: 'wdi_2', currency: 'CAD' };

    await releaseWithdrawal(intent, 'rail_failed');

    expect(state.updatedIntents[0].values).toMatchObject({ status: 'failed' });
    expect(creditUnit).toHaveBeenCalledWith(expect.anything(), DID, MJN, '5', { currency: 'CAD' });
    expect(state.insertedTransactions[0]).toMatchObject({
      type: 'withdrawal_release',
      sourceKind: 'transfer',
      status: 'completed',
      metadata: { intentId: 'wdi_2', reason: 'rail_failed' },
    });
  });
});

describe('executeWithdrawal — crash-injection (#2172 acceptance criteria)', () => {
  it('rail throws -> intent failed, reservation released, no completed ledger row, exactly one execute call', async () => {
    state.balanceReturningQueue.push([{ did: DID, unit: MJN, amount: '95' }]);
    const rail = new FakeRail({ failWith: new Error('rail down') });

    await expect(executeWithdrawal({ did: DID, unit: MJN, amount: 5, rail })).rejects.toThrow('rail down');

    expect(rail.executeCalls).toHaveLength(1);
    expect(state.updatedIntents[0].values).toMatchObject({ status: 'failed' });
    expect(creditUnit).toHaveBeenCalledTimes(1);
    // No completed-transaction (receipt) row was ever written — only the
    // release row, and confirmWithdrawal was never reached.
    expect(state.insertedTransactions).toHaveLength(1);
    expect(state.insertedTransactions[0].type).toBe('withdrawal_release');
  });

  it('rail succeeds -> intent completed, receipt transaction recorded, reservation never released', async () => {
    state.balanceReturningQueue.push([{ did: DID, unit: MJN, amount: '95' }]);
    const rail = new FakeRail();

    const result = await executeWithdrawal({ did: DID, unit: MJN, amount: 5, rail, destination: 'acct_1' });

    expect(result.externalRef).toBe(rail.distinctExternalRefs[0]);
    expect(state.updatedIntents[0].values).toMatchObject({ status: 'completed', externalRef: result.externalRef });
    expect(creditUnit).not.toHaveBeenCalled();
  });

  it('retrying rail.execute against the SAME already-reserved intent never mints a second external transfer', async () => {
    state.balanceReturningQueue.push([{ did: DID, unit: MJN, amount: '95' }]);
    const rail = new FakeRail();
    const intent = await reserveWithdrawal({ did: DID, unit: MJN, amount: 5, rail: rail.name });

    const first = await rail.execute(intent);
    const second = await rail.execute(intent); // simulates a retry against the same durable intent

    expect(second.externalRef).toBe(first.externalRef);
    expect(rail.distinctExternalRefs).toHaveLength(1);
    expect(rail.executeCalls).toHaveLength(2);
  });
});

describe('confirmWithdrawalFromRailEvent (#2172 webhook fast path)', () => {
  it('confirms a pending intent it can resolve from the rail event', async () => {
    state.intentRows.push({ id: 'wdi_3', did: DID, unit: MJN, amount: '5', rail: 'fake', idempotencyKey: 'wdi_3', status: 'pending' });
    const rail = new FakeRail();

    const intentId = await confirmWithdrawalFromRailEvent(rail, { type: 'fake.transfer.created', intentId: 'wdi_3', externalRef: 'fake_tr_9' });

    expect(intentId).toBe('wdi_3');
    expect(state.updatedIntents[0].values).toMatchObject({ status: 'completed', externalRef: 'fake_tr_9' });
  });

  it('is idempotent — a replayed event for an already-completed intent does not re-confirm', async () => {
    state.intentRows.push({ id: 'wdi_4', did: DID, unit: MJN, amount: '5', rail: 'fake', idempotencyKey: 'wdi_4', status: 'completed' });
    const rail = new FakeRail();

    const intentId = await confirmWithdrawalFromRailEvent(rail, { type: 'fake.transfer.created', intentId: 'wdi_4', externalRef: 'fake_tr_9' });

    expect(intentId).toBe('wdi_4');
    expect(state.updatedIntents).toHaveLength(0);
    expect(state.insertedTransactions).toHaveLength(0);
  });

  it('returns null for an unrecognized event without touching any intent', async () => {
    const rail = new FakeRail();
    const intentId = await confirmWithdrawalFromRailEvent(rail, { type: 'unrelated.event' });
    expect(intentId).toBeNull();
    expect(state.updatedIntents).toHaveLength(0);
  });

  it('returns null for an unknown intent id without throwing', async () => {
    const rail = new FakeRail();
    const intentId = await confirmWithdrawalFromRailEvent(rail, { type: 'fake.transfer.created', intentId: 'does-not-exist', externalRef: 'fake_tr_9' });
    expect(intentId).toBeNull();
  });

  it.each(['failed', 'released'] as const)(
    'refuses to resurrect an already-%s intent as completed, and emits an external_completed_after_release discrepancy instead',
    async (status) => {
      state.intentRows.push({ id: 'wdi_released', did: DID, unit: MJN, amount: '5', rail: 'fake', idempotencyKey: 'wdi_released', status });
      const rail = new FakeRail();

      const intentId = await confirmWithdrawalFromRailEvent(rail, {
        type: 'fake.transfer.created',
        intentId: 'wdi_released',
        externalRef: 'fake_tr_late',
      });

      // Never resurrected: no completion, no receipt row, no status flip.
      expect(intentId).toBeNull();
      expect(state.updatedIntents).toHaveLength(0);
      expect(state.insertedTransactions).toHaveLength(0);

      expect(emitReconciliationDiscrepancyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          rail: 'fake',
          intentId: 'wdi_released',
          externalRef: 'fake_tr_late',
          amount: '5',
          unit: MJN,
          bucket: 'external_completed_after_release',
          did: DID,
        }),
      );
    },
  );
});
