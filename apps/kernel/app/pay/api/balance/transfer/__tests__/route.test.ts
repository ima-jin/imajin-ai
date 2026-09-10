/**
 * Tests for POST /api/balance/transfer (#2016).
 *
 * A transfer moves a single wallet unit — no more "burn credit then cash"
 * cascade, and never a cross-unit conversion. An unknown unit is a 400.
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

  return {
    whereMock,
    fromMock,
    selectMock,
    insertValuesMock,
    insertMock,
    onConflictDoUpdateMock,
    updateWhereMock,
    setMock,
    updateMock,
    resolveEffectiveDidMock,
  };
});

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));

vi.mock('@imajin/auth', () => ({ resolveEffectiveDid: mocks.resolveEffectiveDidMock }));

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock, insert: mocks.insertMock, update: mocks.updateMock, transaction: (cb: (tx: unknown) => Promise<void>) => cb({ insert: mocks.insertMock, update: mocks.updateMock }) },
  balances: { did: 'did', unit: 'unit', amount: 'amount' },
  transactions: {},
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const FROM_DID = 'did:imajin:sender';
const TO_DID = 'did:imajin:recipient';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/balance/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockBalanceRow(row: { did: string; unit: string; amount: string; currency: string } | undefined) {
  mocks.whereMock.mockImplementationOnce(() => ({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveEffectiveDidMock.mockResolvedValue({ ok: true, effectiveDid: FROM_DID });
});

describe('POST /api/balance/transfer — unit-aware (#2016)', () => {
  it('rejects an unknown unit with a 400, never a conversion', async () => {
    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10, unit: 'BTC' }) as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown unit/);
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('defaults to MJN when unit is omitted', async () => {
    mockBalanceRow({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    mockBalanceRow(undefined); // recipient has no existing row

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unit).toBe('MJN');
  });

  it('transfers MJNx to MJNx — both legs touch the same unit row, never laundered into MJN', async () => {
    mockBalanceRow({ did: FROM_DID, unit: 'MJNx', amount: '50', currency: 'CAD' });
    mockBalanceRow(undefined);

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 20, unit: 'MJNx' }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ unit: 'MJNx', source: 'credit' });

    const txValues = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.type === 'transfer')?.[0];
    expect(txValues).toMatchObject({ unit: 'MJNx', sourceKind: 'transfer' });

    const balanceCredit = mocks.insertValuesMock.mock.calls.find((c) => c[0]?.did === TO_DID)?.[0];
    expect(balanceCredit).toMatchObject({ unit: 'MJNx', amount: '20' });
  });

  it('rejects when the requested unit balance is insufficient', async () => {
    mockBalanceRow({ did: FROM_DID, unit: 'MJN', amount: '5', currency: 'CAD' });

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10, unit: 'MJN' }) as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJN balance/);
  });

  it('forbids transferring from a DID other than the authenticated one', async () => {
    const res = await POST(makeRequest({ from_did: 'did:imajin:someone-else', to_did: TO_DID, amount: 10 }) as never);
    expect(res.status).toBe(403);
  });
});
