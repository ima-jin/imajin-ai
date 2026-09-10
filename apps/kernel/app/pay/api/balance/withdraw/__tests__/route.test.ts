/**
 * Tests for POST /api/balance/withdraw (#2016) — withdraw rails read/write
 * the MJN unit row exclusively.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  balanceRowQueue: [] as Array<{ did: string; unit: string; amount: string; currency: string } | undefined>,
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
  return balanceRouteDbModule(state, { balanceRowQueue: state.balanceRowQueue });
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

  it('rejects insufficient MJN balance', async () => {
    state.balanceRowQueue.push({ did: DID, unit: 'MJN', amount: '0.50', currency: 'CAD' });
    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);
    expect(res.status).toBe(400);
  });

  it('debits the MJN row and records a receipt-kind transaction on success', async () => {
    state.balanceRowQueue.push({ did: DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(200);
    expect(state.transferCreateMock).toHaveBeenCalled();
    const txValues = state.insertCalls[0].values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt', type: 'withdrawal' });
    expect(state.updateCalls).toHaveLength(1);
  });
});
