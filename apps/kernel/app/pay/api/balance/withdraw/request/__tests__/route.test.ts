/**
 * Tests for POST /api/balance/withdraw/request (#2016) — reads the MJN
 * unit row's amount/withdrawalsEnabled exclusively.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  balanceRowQueue: [] as Array<{ did: string; unit: string; amount: string; withdrawalsEnabled: boolean } | undefined>,
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
  return balanceRouteDbModule(state, { balanceRowQueue: state.balanceRowQueue, extra: { withdrawalRequests: {} } });
});

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

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

  it('rejects insufficient MJN balance', async () => {
    state.balanceRowQueue.push({ did: DID, unit: 'MJN', amount: '5', withdrawalsEnabled: true });
    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);
    expect(res.status).toBe(400);
  });

  it('debits MJN and records a receipt-kind pending transaction on success', async () => {
    state.balanceRowQueue.push({ did: DID, unit: 'MJN', amount: '100', withdrawalsEnabled: true });
    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);

    expect(res.status).toBe(200);
    const txValues = state.insertCalls.find((c) => c.values.type === 'withdrawal')?.values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt', status: 'pending' });
  });
});
