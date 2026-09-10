/**
 * Tests for POST /api/balance/event-topup (#2016).
 *
 * The cash (refund) leg and credit (bonus) leg now land on separate
 * per-unit balance rows (MJN / MJNx), so each nonzero leg gets its own
 * transaction row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const insertValuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));

  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const requireAuthMock = vi.fn();

  return { whereMock, fromMock, selectMock, insertValuesMock, insertMock, onConflictDoUpdateMock, updateWhereMock, setMock, updateMock, requireAuthMock };
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
    insert: mocks.insertMock,
    update: mocks.updateMock,
    transaction: (cb: (tx: unknown) => Promise<void>) => cb({ insert: mocks.insertMock, update: mocks.updateMock }),
  },
  balances: { did: 'did', unit: 'unit', amount: 'amount' },
  transactions: {},
}));

vi.mock('@/src/lib/kernel/id', () => {
  let n = 0;
  return { generateId: (prefix: string) => `${prefix}_${n++}` };
});
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const FROM_DID = 'did:imajin:business';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/balance/event-topup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockSenderBalance(row: { did: string; unit: string; amount: string; currency: string } | undefined) {
  mocks.whereMock.mockImplementationOnce(() => ({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }));
}

const BASE_BODY = {
  from_did: FROM_DID,
  event_id: 'evt_1',
  recipient_dids: ['did:imajin:r1'],
  metadata: { ticket_price: 10 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuthMock.mockResolvedValue({ identity: { id: FROM_DID } });
});

describe('POST /api/balance/event-topup — per-unit balance writes (#2016)', () => {
  it('rejects a missing multiplier', async () => {
    const res = await POST(makeRequest({ ...BASE_BODY }) as never);
    expect(res.status).toBe(400);
  });

  it('rejects multiplier below 1.0', async () => {
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 0.5 }) as never);
    expect(res.status).toBe(400);
  });

  it('rejects a missing ticket_price', async () => {
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 2, metadata: {} }) as never);
    expect(res.status).toBe(400);
  });

  it('forbids topping up from a DID other than the authenticated one', async () => {
    const res = await POST(makeRequest({ ...BASE_BODY, from_did: 'did:imajin:other', multiplier: 2 }) as never);
    expect(res.status).toBe(403);
  });

  it('rejects insufficient MJN balance', async () => {
    mockSenderBalance({ did: FROM_DID, unit: 'MJN', amount: '1', currency: 'CAD' });
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 2 }) as never);
    expect(res.status).toBe(400);
  });

  it('multiplier 1.0: only the MJN refund leg is written, no MJNx bonus', async () => {
    mockSenderBalance({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 1.0 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);

    const txValues = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.type === 'event-topup')?.[0];
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'transfer' });
  });

  it('multiplier > 1.0: writes both an MJN refund row and an MJNx bonus row', async () => {
    mockSenderBalance({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 10 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(2);
    expect(body).toMatchObject({ cashPerRecipient: 10, creditPerRecipient: 90 });

    const txInserts = mocks.insertValuesMock.mock.calls.filter((c) => c[0]?.type === 'event-topup').map((c) => c[0]);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'MJN', amount: '10' }),
        expect.objectContaining({ unit: 'MJNx', amount: '90' }),
      ]),
    );
  });
});
