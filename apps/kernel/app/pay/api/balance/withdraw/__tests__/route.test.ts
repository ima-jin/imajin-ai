/**
 * Tests for POST /api/balance/withdraw (#2016, #2166) — withdraw rails
 * read/write the MJN unit row exclusively.
 *
 * #2166: the MJN debit is now a single guarded conditional UPDATE
 * (`debitUnitIfSufficient` in `src/lib/pay/ledger.ts`), reserved BEFORE
 * the Stripe transfer is created — not a pre-transaction `getBalanceRow`
 * read compared in JS, followed by an unconditional debit AFTER Stripe
 * already sent real money. `state.returningQueue` simulates the
 * `.returning()` result of the guarded UPDATE, same convention as the
 * gift/event-topup route suites (#2018).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  returningQueue: [] as Array<Record<string, unknown>[]>,
  requireAuthMock: vi.fn(),
  transferCreateMock: vi.fn(),
}));

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return { withLogger: withLoggerPassthrough() };
});

vi.mock('@imajin/auth', () => ({
  requireAuth: state.requireAuthMock,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/db', async () => {
  const { balanceRouteDbModule } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return balanceRouteDbModule(state, { returningQueue: state.returningQueue });
});

vi.mock('stripe', () => ({
  default: class {
    transfers = { create: state.transferCreateMock };
  },
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const DID = 'did:imajin:owner';

function makeRequest(body: Record<string, unknown>): Request {
  return jsonPostRequest('https://kernel.test/api/balance/withdraw', body);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  state.requireAuthMock.mockResolvedValue({ identity: { id: DID } });
  state.transferCreateMock.mockResolvedValue({ id: 'tr_test' });
});

describe('POST /api/balance/withdraw — MJN-only (#2016)', () => {
  it('rejects an amount below the minimum', async () => {
    const res = await POST(makeRequest({ amount: 1, account_id: 'acct_1' }) as never);
    expect(res.status).toBe(400);
  });

  it('rejects insufficient MJN balance with a 402, and never calls Stripe (#2166 guarded UPDATE)', async () => {
    // The guarded UPDATE itself is attempted (that's the sufficiency check), it just matches zero rows.
    state.returningQueue.push([]);
    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJN balance/);
    expect(state.updateCalls).toHaveLength(1);
    // The reservation is checked BEFORE Stripe is ever called — no real
    // money moves for an unbacked withdrawal.
    expect(state.transferCreateMock).not.toHaveBeenCalled();
    // Rollback evidence: no transaction row was ever issued.
    expect(state.insertCalls).toHaveLength(0);
  });

  it('debits the MJN row and records a receipt-kind transaction on success', async () => {
    state.returningQueue.push([{ did: DID, unit: 'MJN', amount: '95', currency: 'CAD' }]);
    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(200);
    expect(state.transferCreateMock).toHaveBeenCalled();
    const txValues = state.insertCalls[0].values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt', type: 'withdrawal' });
    expect(state.updateCalls).toHaveLength(1);
  });

  it('rolls back the guarded debit (and never records a transaction) when the Stripe transfer itself fails', async () => {
    state.returningQueue.push([{ did: DID, unit: 'MJN', amount: '95', currency: 'CAD' }]);
    state.transferCreateMock.mockRejectedValueOnce(new Error('stripe down'));

    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(500);
    // The guarded debit was attempted, but its effect (and the transaction
    // row) never commits because the Stripe call inside the same
    // `db.transaction()` threw.
    expect(state.insertCalls).toHaveLength(0);
  });
});

describe('POST /api/balance/withdraw — concurrent debit race (#2166: TOCTOU)', () => {
  it('two parallel withdrawals against a balance that covers only one: exactly one 200 (one Stripe call), one 402 (no Stripe call)', async () => {
    state.returningQueue.push([{ did: DID, unit: 'MJN', amount: '0', currency: 'CAD' }], []);

    const req = () => makeRequest({ amount: 500, account_id: 'acct_1' }) as never;
    const [resA, resB] = await Promise.all([POST(req()), POST(req())]);
    const statuses = [resA.status, resB.status].sort();

    expect(statuses).toEqual([200, 402]);
    // Only the winner's guarded debit reached Stripe — the loser's guard
    // failed before any real money could move.
    expect(state.transferCreateMock).toHaveBeenCalledTimes(1);
    expect(state.updateCalls).toHaveLength(2);
    expect(state.insertCalls).toHaveLength(1);
  });
});
