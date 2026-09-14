/**
 * Tests for POST /api/balance/event-topup (#2016, #2018).
 *
 * The cash (refund) leg and credit (bonus) leg now land on separate
 * per-unit balance rows (MJN / MJNx), so each nonzero leg gets its own
 * transaction row.
 *
 * #2018: event-topup is a FUNDED TRANSFER, never a mint — from_did's MJN
 * balance backs the refund leg and its MJNx balance backs the bonus leg.
 * Insufficient balance in either unit is a 402, and neither leg is written
 * unless both legs can be funded.
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

  it('rejects insufficient MJN balance with a 402, never a mint', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '1', currency: 'CAD' });
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 2 }) as never);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJN balance/);
    expect(state.insertCalls).toHaveLength(0);
    expect(state.updateCalls).toHaveLength(0);
  });

  it('rejects insufficient MJNx balance with a 402, never a mint (#2018)', async () => {
    state.balanceRowQueue.push(
      { did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' },
      { did: FROM_DID, unit: 'MJNx', amount: '5', currency: 'CAD' },
    );
    // ticket_price 10, multiplier 10 => bonus leg is 90 per recipient, far
    // beyond the business's 5 MJNx on hand.
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 10 }) as never);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJNx balance/);
    // Atomic: the MJN refund leg must not be written either, even though it
    // alone was sufficiently funded.
    expect(state.insertCalls).toHaveLength(0);
    expect(state.updateCalls).toHaveLength(0);
  });

  it('multiplier 1.0: only the MJN refund leg is written, no MJNx bonus', async () => {
    state.balanceRowQueue.push(
      { did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' },
      { did: FROM_DID, unit: 'MJNx', amount: '0', currency: 'CAD' },
    );
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 1.0 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);

    const txValues = state.insertCalls.find((c) => c.values.type === 'event-topup')?.values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'transfer' });
    // Only the cash leg's debit runs — no MJNx debit when the bonus is 0.
    expect(state.updateCalls).toHaveLength(1);
  });

  it('multiplier > 1.0: writes both an MJN refund row and an MJNx bonus row, debiting from_did in both units (#2018)', async () => {
    state.balanceRowQueue.push(
      { did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' },
      { did: FROM_DID, unit: 'MJNx', amount: '100', currency: 'CAD' },
    );
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

    // Total supply is conserved: the business is debited exactly what the
    // recipient receives in each unit — one debit per unit.
    expect(state.updateCalls).toHaveLength(2);
  });
});
