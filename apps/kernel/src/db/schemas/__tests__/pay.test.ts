/**
 * Smoke test for apps/kernel/src/db/schemas/pay.ts (#2016).
 *
 * Every other pay test mocks `@/src/db`, so the real schema module never
 * loads under test. Building Drizzle table objects requires no DB
 * connection, so this test imports the real module directly and asserts
 * the row-per-(did, unit) `balances` shape and the new `transactions`
 * columns (`unit`, `sourceKind`, `attestationId`) exist.
 */
import { describe, it, expect } from 'vitest';
import { balances, transactions, paySchema } from '../pay';

describe('pay schema (#2016)', () => {
  it('balances is keyed by (did, unit) with an amount column', () => {
    expect(balances.did).toBeDefined();
    expect(balances.unit).toBeDefined();
    expect(balances.amount).toBeDefined();
    expect(balances.currency).toBeDefined();
    expect(balances.withdrawalsEnabled).toBeDefined();
  });

  it('transactions carries unit, sourceKind, and attestationId', () => {
    expect(transactions.unit).toBeDefined();
    expect(transactions.sourceKind).toBeDefined();
    expect(transactions.attestationId).toBeDefined();
    expect(transactions.currency).toBeDefined();
  });

  it('is scoped to the pay Postgres schema', () => {
    expect(paySchema).toBeDefined();
  });
});
