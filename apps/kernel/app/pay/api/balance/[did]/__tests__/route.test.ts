/**
 * Tests for GET /api/balance/[did] (#2016).
 *
 * Response is now an explicit per-unit array — MJN (withdrawable) and
 * MJNx (emitted, never withdrawable) are always distinct entries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  whereMock: vi.fn(),
  requireAuthMock: vi.fn(),
  requireAppAuthMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  requireAppAuth: mocks.requireAppAuthMock,
  resolveActingDid: (identity: { id: string; actingAs?: string | null }) => identity.actingAs ?? identity.id,
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mocks.whereMock }) }),
  },
  balances: { did: 'did', unit: 'unit', amount: 'amount' },
}));

vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { GET } from '../route';

const DID = 'did:imajin:owner';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request(`https://kernel.test/api/balance/${encodeURIComponent(DID)}`, { headers });
}

function params() {
  return { params: Promise.resolve({ did: encodeURIComponent(DID) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuthMock.mockResolvedValue({ identity: { id: DID, actingAs: null } });
  mocks.whereMock.mockResolvedValue([]);
});

describe('GET /api/balance/[did] — per-unit balances array (#2016)', () => {
  it('returns 401 when unauthenticated', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized' });
    const res = await GET(makeRequest() as never, params());
    expect(res.status).toBe(401);
  });

  it('returns 403 for a DID other than the authenticated one', async () => {
    mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:someone-else', actingAs: null } });
    const res = await GET(makeRequest() as never, params());
    expect(res.status).toBe(403);
  });

  it('returns both MJN and MJNx entries, defaulting to 0 when no rows exist', async () => {
    mocks.whereMock.mockResolvedValue([]);
    const res = await GET(makeRequest() as never, params());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balances).toEqual([
      { unit: 'MJN', amount: 0, withdrawable: true },
      { unit: 'MJNx', amount: 0, withdrawable: false },
    ]);
    expect(body.total).toBe(0);
  });

  it('reflects existing MJN/MJNx rows and sums them into total', async () => {
    mocks.whereMock.mockResolvedValue([
      { did: DID, unit: 'MJN', amount: '40', currency: 'CAD', withdrawalsEnabled: true, updatedAt: new Date('2026-01-01') },
      { did: DID, unit: 'MJNx', amount: '15', currency: 'CAD', withdrawalsEnabled: false, updatedAt: new Date('2026-01-02') },
    ]);

    const res = await GET(makeRequest() as never, params());
    const body = await res.json();

    expect(body.balances).toEqual([
      { unit: 'MJN', amount: 40, withdrawable: true },
      { unit: 'MJNx', amount: 15, withdrawable: false },
    ]);
    expect(body.total).toBe(55);
    expect(body.currency).toBe('CAD');
  });

  it('resolves via the app-auth path when x-app-did is present', async () => {
    mocks.requireAppAuthMock.mockResolvedValue({ appAuth: { userDid: DID } });
    const res = await GET(makeRequest({ 'x-app-did': 'did:imajin:some-app' }) as never, params());
    expect(res.status).toBe(200);
    expect(mocks.requireAppAuthMock).toHaveBeenCalled();
  });

  it('returns 500 without leaking the underlying error when the query throws', async () => {
    mocks.whereMock.mockRejectedValue(new Error('db down'));
    const res = await GET(makeRequest() as never, params());
    expect(res.status).toBe(500);
  });
});
