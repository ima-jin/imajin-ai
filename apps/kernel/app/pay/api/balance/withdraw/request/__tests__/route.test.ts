/**
 * Tests for POST /api/balance/withdraw/request (#2016, #2166) — reads the
 * MJN unit row's amount/withdrawalsEnabled exclusively.
 *
 * #2166: sufficiency is now enforced by a single guarded conditional
 * UPDATE (`debitUnitIfSufficient` in `src/lib/pay/ledger.ts`) inside the
 * same transaction as the withdrawal-request and transaction inserts —
 * not the pre-transaction `amountOf(balance)` comparison this route used
 * to make. `state.balanceRowQueue` still drives the 404/403 checks (which
 * are not sufficiency checks); `state.returningQueue` simulates the
 * guarded UPDATE's `.returning()` result, same convention as the gift/
 * event-topup route suites (#2018).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  balanceRowQueue: [] as Array<{ did: string; unit: string; amount: string; withdrawalsEnabled: boolean } | undefined>,
  returningQueue: [] as Array<Record<string, unknown>[]>,
  requireAuthMock: vi.fn(),
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
  return balanceRouteDbModule(state, {
    balanceRowQueue: state.balanceRowQueue,
    returningQueue: state.returningQueue,
    extra: { withdrawalRequests: {} },
  });
});

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { db } from '@/src/db';
import { POST } from '../route';

const DID = 'did:imajin:owner';

function makeRequest(body: Record<string, unknown>): Request {
  return jsonPostRequest('https://kernel.test/api/balance/withdraw/request', body);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  state.requireAuthMock.mockResolvedValue({ identity: { id: DID } });
});

describe('POST /api/balance/withdraw/request — MJN-only (#2016)', () => {
  it('rejects an amount below the minimum', async () => {
    const res = await POST(makeRequest({ amount: 1, emt_email: 'a@b.com' }) as never);
    expect(res.status).toBe(400);
  });

  it('returns 404 when no MJN balance row exists', async () => {
    state.balanceRowQueue.push(undefined);
    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);
    expect(res.status).toBe(404);
  });

  it('returns 403 when withdrawals are not enabled', async () => {
    state.balanceRowQueue.push({ did: DID, unit: 'MJN', amount: '100', withdrawalsEnabled: false });
    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);
    expect(res.status).toBe(403);
  });

  it('rejects insufficient MJN balance with a 402, never a partial write (#2166 guarded UPDATE)', async () => {
    state.balanceRowQueue.push({ did: DID, unit: 'MJN', amount: '100', withdrawalsEnabled: true });
    // The guarded UPDATE itself is attempted (that's the sufficiency check), it just matches zero rows.
    state.returningQueue.push([]);

    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJN balance/);
    expect(state.updateCalls).toHaveLength(1);
    // Rollback evidence: neither the withdrawal-request row nor the
    // transaction row was ever issued.
    expect(state.insertCalls).toHaveLength(0);
  });

  it('debits MJN and records a receipt-kind pending transaction on success', async () => {
    state.balanceRowQueue.push({ did: DID, unit: 'MJN', amount: '100', withdrawalsEnabled: true });
    state.returningQueue.push([{ did: DID, unit: 'MJN', amount: '80', withdrawalsEnabled: true }]);

    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);

    expect(res.status).toBe(200);
    const txValues = state.insertCalls.find((c) => c.values.type === 'withdrawal')?.values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt', status: 'pending' });
  });

  it('re-throws a genuinely unexpected transaction error, never swallowing it as an insufficient-balance 402', async () => {
    state.balanceRowQueue.push({ did: DID, unit: 'MJN', amount: '100', withdrawalsEnabled: true });
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('unexpected db failure'));

    await expect(POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never)).rejects.toThrow(
      'unexpected db failure',
    );
  });
});

describe('POST /api/balance/withdraw/request — concurrent debit race (#2166: TOCTOU)', () => {
  it('two parallel withdrawal requests against a balance that covers only one: exactly one 200, one 402, balance never goes negative', async () => {
    state.balanceRowQueue.push(
      { did: DID, unit: 'MJN', amount: '20', withdrawalsEnabled: true },
      { did: DID, unit: 'MJN', amount: '20', withdrawalsEnabled: true },
    );
    state.returningQueue.push([{ did: DID, unit: 'MJN', amount: '0', withdrawalsEnabled: true }], []);

    const req = () => makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never;
    const [resA, resB] = await Promise.all([POST(req()), POST(req())]);
    const statuses = [resA.status, resB.status].sort();

    expect(statuses).toEqual([200, 402]);
    expect(state.updateCalls).toHaveLength(2);
    // Exactly one withdrawal-request row was created — the loser never
    // wrote one. `status: 'requested'` is unique to the withdrawalRequests
    // insert (the transactions insert uses 'pending').
    const withdrawalRequestInserts = state.insertCalls.filter((c) => c.values.status === 'requested');
    expect(withdrawalRequestInserts).toHaveLength(1);
  });
});
