/**
 * Tests for POST /api/balance/gift (#2016).
 *
 * The cash leg and credit leg now land on separate per-unit balance rows
 * (MJN / MJNx), so each nonzero leg gets its own transaction row instead of
 * one row spanning both buckets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  balanceRowQueue: [] as Array<{ did: string; unit: string; amount: string; currency: string } | undefined>,
  resolveEffectiveDidMock: vi.fn(),
}));

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return { withLogger: withLoggerPassthrough() };
});

vi.mock('@imajin/auth', () => ({ resolveEffectiveDid: state.resolveEffectiveDidMock }));

vi.mock('@/src/db', async () => {
  const { balanceRouteDbModule } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return balanceRouteDbModule(state, { balanceRowQueue: state.balanceRowQueue });
});

vi.mock('@/src/lib/kernel/id', () => {
  let n = 0;
  return { generateId: (prefix: string) => `${prefix}_${n++}` };
});
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const FROM_DID = 'did:imajin:business';

function makeRequest(body: Record<string, unknown>): Request {
  return jsonPostRequest('https://kernel.test/api/balance/gift', body);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  state.resolveEffectiveDidMock.mockResolvedValue({ ok: true, effectiveDid: FROM_DID });
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
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '1', currency: 'CAD' });
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 10 }] }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('writes an MJN transaction + balance credit for the cash leg only', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 10 }] }) as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);

    const txValues = state.insertCalls.find((c) => c.values.type === 'gift')?.values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'transfer', toDid: 'did:imajin:r1' });
    const balanceValues = state.insertCalls.find((c) => c.values.did === 'did:imajin:r1')?.values;
    expect(balanceValues).toMatchObject({ unit: 'MJN', amount: '10' });
  });

  it('writes both an MJN row and an MJNx row when both legs are nonzero', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(
      makeRequest({
        from_did: FROM_DID,
        recipients: [{ did: 'did:imajin:r1', cash_amount: 10, credit_amount: 5 }],
      }) as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(2);

    const txInserts = state.insertCalls.filter((c) => c.values.type === 'gift').map((c) => c.values);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'MJN', amount: '10' }),
        expect.objectContaining({ unit: 'MJNx', amount: '5' }),
      ]),
    );
  });

  it('skips a recipient whose gift amounts are both zero', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 0, credit_amount: 0 }] }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(0);
  });
});
