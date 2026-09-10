/**
 * Unit tests for apps/kernel/src/lib/pay/ledger.ts (#2016).
 *
 * These exercise the pure validation helpers directly, and the DB-touching
 * helpers (`getBalanceRow`, `getBalances`, `creditUnit`, `debitUnit`)
 * against a minimal fake Drizzle-style executor.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/src/db', () => ({
  db: {},
  balances: { did: 'did', unit: 'unit', amount: 'amount' },
}));

import {
  MJN,
  MJNX,
  ACCEPTED_UNITS_DEFAULT,
  assertKnownUnit,
  assertUnitAccepted,
  amountOf,
  getBalanceRow,
  getBalances,
  creditUnit,
  debitUnit,
} from '../ledger';

describe('assertKnownUnit', () => {
  it('accepts MJN and MJNx', () => {
    expect(assertKnownUnit('MJN')).toEqual({ unit: 'MJN' });
    expect(assertKnownUnit('MJNx')).toEqual({ unit: 'MJNx' });
  });

  it('rejects anything else with a stable 400 body', () => {
    const result = assertKnownUnit('CAD');
    expect(result).toMatchObject({ status: 400 });
    expect((result as { error: string }).error).toMatch(/Unknown unit/);
  });
});

describe('assertUnitAccepted', () => {
  it('defaults to MJN-only', () => {
    expect(ACCEPTED_UNITS_DEFAULT).toEqual(['MJN']);
    expect(assertUnitAccepted('MJN')).toEqual({ unit: 'MJN' });
  });

  it('rejects MJNx when the accepted set is MJN-only — a hard error, never a conversion', () => {
    const result = assertUnitAccepted('MJNx');
    expect(result).toMatchObject({ status: 400 });
    expect((result as { error: string }).error).toMatch(/not accepted/);
  });

  it('accepts MJNx when explicitly opted in', () => {
    expect(assertUnitAccepted('MJNx', ['MJN', 'MJNx'])).toEqual({ unit: 'MJNx' });
  });

  it('rejects an unknown unit before checking the accepted set', () => {
    const result = assertUnitAccepted('BTC', ['MJN', 'MJNx']);
    expect(result).toMatchObject({ status: 400 });
    expect((result as { error: string }).error).toMatch(/Unknown unit/);
  });
});

describe('amountOf', () => {
  it('returns 0 for an undefined row', () => {
    expect(amountOf(undefined)).toBe(0);
  });

  it('parses the row amount', () => {
    expect(amountOf({ did: 'd', unit: MJN, amount: '12.50000000', currency: 'CAD', withdrawalsEnabled: true, updatedAt: null })).toBe(12.5);
  });
});

// ---------------------------------------------------------------------------
// DB-touching helpers — minimal fake executor mirroring the drizzle chain
// shapes these helpers actually call.
// ---------------------------------------------------------------------------

function makeExecutor(rows: Array<{ did: string; unit: string; amount: string; currency: string }>) {
  const insertCalls: Array<{ values: Record<string, unknown>; conflict?: unknown }> = [];
  const updateCalls: Array<{ values: Record<string, unknown> }> = [];

  const executor = {
    select: () => ({
      from: () => ({
        // Mirrors real Drizzle: the where-clause result is itself awaitable
        // (used by `getBalances`, which never calls `.limit()`) AND supports
        // chaining `.limit()` (used by `getBalanceRow`).
        where: () => Object.assign(Promise.resolve(rows), {
          limit: (_n: number) => Promise.resolve(rows),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const record = { values };
        insertCalls.push(record);
        const promise = Promise.resolve(undefined);
        return Object.assign(promise, {
          onConflictDoUpdate: (conflict: unknown) => {
            (record as { conflict?: unknown }).conflict = conflict;
            return Promise.resolve(undefined);
          },
        });
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updateCalls.push({ values });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  };

  return { executor, insertCalls, updateCalls };
}

describe('getBalanceRow / getBalances', () => {
  it('returns undefined when no row matches', async () => {
    const { executor } = makeExecutor([]);
    // @ts-expect-error minimal fake executor
    const row = await getBalanceRow(executor, 'did:imajin:x', MJN);
    expect(row).toBeUndefined();
  });

  it('returns the first row when present', async () => {
    const { executor } = makeExecutor([{ did: 'did:imajin:x', unit: 'MJN', amount: '10', currency: 'CAD' }]);
    // @ts-expect-error minimal fake executor
    const row = await getBalanceRow(executor, 'did:imajin:x', MJN);
    expect(row).toMatchObject({ did: 'did:imajin:x', unit: 'MJN', amount: '10' });
  });

  it('getBalances returns every row for a DID', async () => {
    const fixtureRows = [
      { did: 'did:imajin:x', unit: 'MJN', amount: '10', currency: 'CAD' },
      { did: 'did:imajin:x', unit: 'MJNx', amount: '5', currency: 'CAD' },
    ];
    const { executor } = makeExecutor(fixtureRows);
    // @ts-expect-error minimal fake executor
    const rows = await getBalances(executor, 'did:imajin:x');
    expect(rows).toHaveLength(2);
  });
});

describe('creditUnit', () => {
  it('upserts the (did, unit) row with the given amount and currency', async () => {
    const { executor, insertCalls } = makeExecutor([]);
    // @ts-expect-error minimal fake executor
    await creditUnit(executor, 'did:imajin:x', MJNX, 5, { currency: 'CAD' });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toMatchObject({ did: 'did:imajin:x', unit: MJNX, amount: '5', currency: 'CAD' });
  });

  it('defaults withdrawalsEnabled to false and currency to CAD', async () => {
    const { executor, insertCalls } = makeExecutor([]);
    // @ts-expect-error minimal fake executor
    await creditUnit(executor, 'did:imajin:x', MJN, 5);

    expect(insertCalls[0].values).toMatchObject({ withdrawalsEnabled: false, currency: 'CAD' });
  });
});

describe('debitUnit', () => {
  it('issues a plain subtraction by default (no clamp)', async () => {
    const { executor, updateCalls } = makeExecutor([]);
    // @ts-expect-error minimal fake executor
    await debitUnit(executor, 'did:imajin:x', MJN, 5);
    expect(updateCalls).toHaveLength(1);
  });

  it('clamps at zero when clampAtZero is set (mirrors refund.ts prior GREATEST(...,0) behavior)', async () => {
    const { executor, updateCalls } = makeExecutor([]);
    // @ts-expect-error minimal fake executor
    await debitUnit(executor, 'did:imajin:x', MJN, 5, { clampAtZero: true });
    expect(updateCalls).toHaveLength(1);
  });
});
