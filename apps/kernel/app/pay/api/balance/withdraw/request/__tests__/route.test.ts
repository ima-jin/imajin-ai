/**
 * Tests for POST /api/balance/withdraw/request (#2016) — reads the MJN
 * unit row's amount/withdrawalsEnabled exclusively.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));

  const requireAuthMock = vi.fn();

  return { whereMock, fromMock, selectMock, updateWhereMock, setMock, updateMock, insertValuesMock, insertMock, requireAuthMock };
});

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/db', () => ({
  db: {
    select: mocks.selectMock,
    update: mocks.updateMock,
    insert: mocks.insertMock,
    transaction: (cb: (tx: unknown) => Promise<void>) => cb({ insert: mocks.insertMock, update: mocks.updateMock }),
  },
  balances: { did: 'did', unit: 'unit', amount: 'amount' },
  transactions: {},
  withdrawalRequests: {},
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const DID = 'did:imajin:owner';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/balance/withdraw/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockBalance(row: { did: string; unit: string; amount: string; withdrawalsEnabled: boolean } | undefined) {
  mocks.whereMock.mockImplementationOnce(() => ({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuthMock.mockResolvedValue({ identity: { id: DID } });
});

describe('POST /api/balance/withdraw/request — MJN-only (#2016)', () => {
  it('rejects an amount below the minimum', async () => {
    const res = await POST(makeRequest({ amount: 1, emt_email: 'a@b.com' }) as never);
    expect(res.status).toBe(400);
  });

  it('returns 404 when no MJN balance row exists', async () => {
    mockBalance(undefined);
    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);
    expect(res.status).toBe(404);
  });

  it('returns 403 when withdrawals are not enabled', async () => {
    mockBalance({ did: DID, unit: 'MJN', amount: '100', withdrawalsEnabled: false });
    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);
    expect(res.status).toBe(403);
  });

  it('rejects insufficient MJN balance', async () => {
    mockBalance({ did: DID, unit: 'MJN', amount: '5', withdrawalsEnabled: true });
    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);
    expect(res.status).toBe(400);
  });

  it('debits MJN and records a receipt-kind pending transaction on success', async () => {
    mockBalance({ did: DID, unit: 'MJN', amount: '100', withdrawalsEnabled: true });
    const res = await POST(makeRequest({ amount: 20, emt_email: 'a@b.com' }) as never);

    expect(res.status).toBe(200);
    const txValues = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.type === 'withdrawal')?.[0];
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt', status: 'pending' });
  });
});
