/**
 * Tests for POST /api/balance/gift (#2016).
 *
 * The cash leg and credit leg now land on separate per-unit balance rows
 * (MJN / MJNx), so each nonzero leg gets its own transaction row instead of
 * one row spanning both buckets.
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

  const resolveEffectiveDidMock = vi.fn();

  return { whereMock, fromMock, selectMock, insertValuesMock, insertMock, onConflictDoUpdateMock, updateWhereMock, setMock, updateMock, resolveEffectiveDidMock };
});

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));

vi.mock('@imajin/auth', () => ({ resolveEffectiveDid: mocks.resolveEffectiveDidMock }));

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
  return new Request('https://kernel.test/api/balance/gift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockSenderBalance(row: { did: string; unit: string; amount: string; currency: string } | undefined) {
  mocks.whereMock.mockImplementationOnce(() => ({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveEffectiveDidMock.mockResolvedValue({ ok: true, effectiveDid: FROM_DID });
});

describe('POST /api/balance/gift — per-unit balance writes (#2016)', () => {
  it('rejects a missing recipients array', async () => {
    const res = await POST(makeRequest({ from_did: FROM_DID }) as never);
    expect(res.status).toBe(400);
  });

  it('forbids gifting from a DID other than the authenticated one', async () => {
    const res = await POST(makeRequest({ from_did: 'did:imajin:other', recipients: [{ did: 'x', cash_amount: 1 }] }) as never);
    expect(res.status).toBe(403);
  });

  it('rejects negative recipient amounts', async () => {
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: -5 }] }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('rejects insufficient MJN balance', async () => {
    mockSenderBalance({ did: FROM_DID, unit: 'MJN', amount: '1', currency: 'CAD' });
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 10 }] }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('writes an MJN transaction + balance credit for the cash leg only', async () => {
    mockSenderBalance({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 10 }] }) as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);

    const txValues = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.type === 'gift')?.[0];
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'transfer', toDid: 'did:imajin:r1' });
    const balanceValues = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.did === 'did:imajin:r1')?.[0];
    expect(balanceValues).toMatchObject({ unit: 'MJN', amount: '10' });
  });

  it('writes both an MJN row and an MJNx row when both legs are nonzero', async () => {
    mockSenderBalance({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(
      makeRequest({
        from_did: FROM_DID,
        recipients: [{ did: 'did:imajin:r1', cash_amount: 10, credit_amount: 5 }],
      }) as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(2);

    const txInserts = mocks.insertValuesMock.mock.calls.filter((c) => c[0]?.type === 'gift').map((c) => c[0]);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'MJN', amount: '10' }),
        expect.objectContaining({ unit: 'MJNx', amount: '5' }),
      ]),
    );
  });

  it('skips a recipient whose gift amounts are both zero', async () => {
    mockSenderBalance({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 0, credit_amount: 0 }] }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(0);
  });
});
