/**
 * Tests for POST /api/balance/topup (#2016) — always credits the MJN unit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
}));

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return { withLogger: withLoggerPassthrough() };
});

vi.mock('@/src/db', async () => {
  const { balanceRouteDbModule } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return balanceRouteDbModule(state);
});

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const API_KEY = 'test-pay-api-key';

function makeRequest(body: Record<string, unknown>): Request {
  return jsonPostRequest('https://kernel.test/api/balance/topup', body, { Authorization: `Bearer ${API_KEY}` });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  process.env.PAY_SERVICE_API_KEY = API_KEY;
});

describe('POST /api/balance/topup — always MJN (#2016)', () => {
  it('rejects a missing API key', async () => {
    const res = await POST(
      new Request('https://kernel.test/api/balance/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: 'x', amount: 10, service: 'coffee', type: 'topup' }),
      }) as never,
    );
    expect(res.status).toBe(401);
  });

  it('rejects a non-positive amount', async () => {
    const res = await POST(makeRequest({ did: 'x', amount: -1, service: 'coffee', type: 'topup' }) as never);
    expect(res.status).toBe(400);
  });

  it('credits the MJN unit row and logs a receipt-kind transaction', async () => {
    const res = await POST(makeRequest({ did: 'did:imajin:x', amount: 25, service: 'coffee', type: 'topup' }) as never);

    expect(res.status).toBe(200);
    const txValues = state.insertCalls.find((c) => c.values.toDid === 'did:imajin:x')?.values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt' });
    const balanceValues = state.insertCalls.find((c) => c.values.did === 'did:imajin:x')?.values;
    expect(balanceValues).toMatchObject({ unit: 'MJN', amount: '25' });
  });
});
