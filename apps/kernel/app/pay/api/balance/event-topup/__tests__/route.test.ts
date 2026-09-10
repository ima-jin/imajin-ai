/**
 * Tests for POST /api/balance/event-topup (#2016).
 *
 * The cash (refund) leg and credit (bonus) leg now land on separate
 * per-unit balance rows (MJN / MJNx), so each nonzero leg gets its own
 * transaction row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  balanceRowQueue: [] as Array<{ did: string; unit: string; amount: string; currency: string } | undefined>,
  requireAuthMock: vi.fn(),
}));

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return { withLogger: withLoggerPassthrough() };
});

vi.mock('@imajin/auth', () => ({
  requireAuth: state.requireAuthMock,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

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
  return jsonPostRequest('https://kernel.test/api/balance/event-topup', body);
}

const BASE_BODY = {
  from_did: FROM_DID,
  event_id: 'evt_1',
  recipient_dids: ['did:imajin:r1'],
  metadata: { ticket_price: 10 },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  state.requireAuthMock.mockResolvedValue({ identity: { id: FROM_DID } });
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
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '1', currency: 'CAD' });
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 2 }) as never);
    expect(res.status).toBe(400);
  });

  it('multiplier 1.0: only the MJN refund leg is written, no MJNx bonus', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 1.0 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);

    const txValues = state.insertCalls.find((c) => c.values.type === 'event-topup')?.values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'transfer' });
  });

  it('multiplier > 1.0: writes both an MJN refund row and an MJNx bonus row', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' });
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 10 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(2);
    expect(body).toMatchObject({ cashPerRecipient: 10, creditPerRecipient: 90 });

    const txInserts = state.insertCalls.filter((c) => c.values.type === 'event-topup').map((c) => c.values);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'MJN', amount: '10' }),
        expect.objectContaining({ unit: 'MJNx', amount: '90' }),
      ]),
    );
  });
});
