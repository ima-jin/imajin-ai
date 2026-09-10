/**
 * Tests for POST /api/balance/topup (#2016) — always credits the MJN unit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const insertValuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  return { onConflictDoUpdateMock, insertValuesMock, insertMock };
});

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));

vi.mock('@/src/db', () => ({
  db: {
    insert: mocks.insertMock,
    transaction: (cb: (tx: unknown) => Promise<void>) => cb({ insert: mocks.insertMock }),
  },
  balances: { did: 'did', unit: 'unit', amount: 'amount' },
  transactions: {},
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const API_KEY = 'test-pay-api-key';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/balance/topup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
    const txValues = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.toDid === 'did:imajin:x')?.[0];
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt' });
    const balanceValues = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.did === 'did:imajin:x')?.[0];
    expect(balanceValues).toMatchObject({ unit: 'MJN', amount: '25' });
  });
});
