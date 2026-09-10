/**
 * Tests for /api/admin/deposits (#2016) — manual EMT deposits credit MJN.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const insertValuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  const requireAdminMock = vi.fn();
  const pgSqlMock = vi.fn().mockResolvedValue([]);
  return { onConflictDoUpdateMock, insertValuesMock, insertMock, requireAdminMock, pgSqlMock };
});

vi.mock('@imajin/auth', () => ({ requireAdmin: mocks.requireAdminMock }));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.pgSqlMock }));

vi.mock('@/src/db', () => ({
  db: {
    insert: mocks.insertMock,
    transaction: (cb: (tx: unknown) => Promise<void>) => cb({ insert: mocks.insertMock }),
  },
  balances: { did: 'did', unit: 'unit', amount: 'amount' },
  transactions: {},
}));

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
  mocks.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });
});

describe('GET /api/admin/deposits', () => {
  it('returns 401 for a non-admin', async () => {
    mocks.requireAdminMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('lists recent fiat topup transactions for an admin', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.pgSqlMock).toHaveBeenCalled();
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
    const txValues = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.toDid === 'did:imajin:x')?.[0];
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'receipt' });
    const balanceValues = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.did === 'did:imajin:x')?.[0];
    expect(balanceValues).toMatchObject({ unit: 'MJN', amount: '50' });
  });
});
