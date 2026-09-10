/**
 * Tests for POST /api/balance/transfer (#2016).
 *
 * A transfer moves a single wallet unit — no more "burn credit then cash"
 * cascade, and never a cross-unit conversion. An unknown unit is a 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  // Consumed in call order: sender balance first, then recipient balance.
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

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const FROM_DID = 'did:imajin:sender';
const TO_DID = 'did:imajin:recipient';

function makeRequest(body: Record<string, unknown>): Request {
  return jsonPostRequest('https://kernel.test/api/balance/transfer', body);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  state.resolveEffectiveDidMock.mockResolvedValue({ ok: true, effectiveDid: FROM_DID });
});

describe('POST /api/balance/transfer — unit-aware (#2016)', () => {
  it('rejects an unknown unit with a 400, never a conversion', async () => {
    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10, unit: 'BTC' }) as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown unit/);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('defaults to MJN when unit is omitted', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' }, undefined);

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unit).toBe('MJN');
  });

  it('transfers MJNx to MJNx — both legs touch the same unit row, never laundered into MJN', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJNx', amount: '50', currency: 'CAD' }, undefined);

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 20, unit: 'MJNx' }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ unit: 'MJNx', source: 'credit' });

    const txValues = state.insertCalls.find((c) => c.values.type === 'transfer')?.values;
    expect(txValues).toMatchObject({ unit: 'MJNx', sourceKind: 'transfer' });

    const balanceCredit = state.insertCalls.find((c) => c.values.did === TO_DID)?.values;
    expect(balanceCredit).toMatchObject({ unit: 'MJNx', amount: '20' });
  });

  it('rejects when the requested unit balance is insufficient', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '5', currency: 'CAD' });

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
