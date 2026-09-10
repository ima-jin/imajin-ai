/**
 * Tests for /api/admin/deposits (#2016) — manual EMT deposits credit MJN.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  requireAdminMock: vi.fn(),
  pgSqlMock: vi.fn().mockResolvedValue([]),
}));

function resetState() {
  state.insertCalls = [];
  state.updateCalls = [];
}

vi.mock('@imajin/auth', () => ({ requireAdmin: state.requireAdminMock }));
vi.mock('@imajin/db', () => ({ getClient: () => state.pgSqlMock }));

vi.mock('@/src/db', async () => {
  const { createMockDb } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  const { insert } = createMockDb(state, () => Promise.resolve([]));
  return {
    db: { insert, transaction: (cb: (tx: unknown) => Promise<void>) => cb({ insert }) },
    balances: { did: 'did', unit: 'unit', amount: 'amount' },
    transactions: {},
  };
});

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));

import { GET, POST } from '../route';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/admin/deposits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  state.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });
  state.pgSqlMock.mockResolvedValue([]);
});

describe('GET /api/admin/deposits', () => {
  it('returns 401 for a non-admin', async () => {
    state.requireAdminMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('lists recent fiat topup transactions for an admin', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(state.pgSqlMock).toHaveBeenCalled();
  });
});

describe('POST /api/admin/deposits — credits MJN (#2016)', () => {
  it('rejects a missing did', async () => {
    const res = await POST(makeRequest({ amount: 10 }) as never);
    expect(res.status).toBe(400);
  });

  it('credits the MJN unit row and logs a receipt-kind transaction', async () => {
    const res = await POST(makeRequest({ did: 'did:imajin:x', amount: 50 }) as never);

    expect(res.status).toBe(200);
    const txValues = state.insertCalls.find((c) => c.values.toDid === 'did:imajin:x')?.values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt' });
    const balanceValues = state.insertCalls.find((c) => c.values.did === 'did:imajin:x')?.values;
    expect(balanceValues).toMatchObject({ unit: 'MJN', amount: '50' });
  });
});
