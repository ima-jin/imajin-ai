/**
 * Tests for POST /api/balance/withdraw (#2016) — withdraw rails read/write
 * the MJN unit row exclusively.
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
  const transferCreateMock = vi.fn();

  return { whereMock, fromMock, selectMock, updateWhereMock, setMock, updateMock, insertValuesMock, insertMock, requireAuthMock, transferCreateMock };
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
}));

vi.mock('stripe', () => ({
  default: class {
    transfers = { create: mocks.transferCreateMock };
  },
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const DID = 'did:imajin:owner';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/balance/withdraw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockBalance(row: { did: string; unit: string; amount: string; currency: string } | undefined) {
  mocks.whereMock.mockImplementationOnce(() => ({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  mocks.requireAuthMock.mockResolvedValue({ identity: { id: DID } });
  mocks.transferCreateMock.mockResolvedValue({ id: 'tr_test' });
});

describe('POST /api/balance/withdraw — MJN-only (#2016)', () => {
  it('rejects an amount below the minimum', async () => {
    const res = await POST(makeRequest({ amount: 1, account_id: 'acct_1' }) as never);
    expect(res.status).toBe(400);
  });

  it('rejects insufficient MJN balance', async () => {
    mockBalance({ did: DID, unit: 'MJN', amount: '0.50', currency: 'CAD' });
    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);
    expect(res.status).toBe(400);
  });

  it('debits the MJN row and records a receipt-kind transaction on success', async () => {
    mockBalance({ did: DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(200);
    expect(mocks.transferCreateMock).toHaveBeenCalled();
    const txValues = mocks.insertValuesMock.mock.calls[0][0];
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt', type: 'withdrawal' });
    expect(mocks.updateMock).toHaveBeenCalled();
  });
});
