/**
 * Tests for POST /api/balance/topup (#2016) — always credits the MJN unit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';
import { SESSION_COOKIE_NAME } from '@imajin/config';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  checkout: vi.fn(),
}));

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return {
    withLogger: withLoggerPassthrough(),
    createLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
  };
});

vi.mock('@/src/db', async () => {
  const { balanceRouteDbModule } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return balanceRouteDbModule(state);
});

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: () => ({ checkout: state.checkout }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

import { POST } from '../route';
import { POST as stripeTopup } from '../../../topup/stripe/route';
import { POST as emtTopup } from '../../../topup/emt/route';

const API_KEY = 'test-pay-api-key';

function makeRequest(body: Record<string, unknown>): Request {
  const token = `${Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url')}.payload.signature`;
  return jsonPostRequest('https://kernel.test/api/balance/topup', body, { Cookie: `${SESSION_COOKIE_NAME}=${token}` });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  process.env.PAY_SERVICE_API_KEY = API_KEY;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ did: 'did:imajin:x' }))));
  state.checkout.mockResolvedValue({ id: 'cs_topup', url: 'https://checkout.test' });
});

describe('POST /api/balance/topup — always MJN (#2016)', () => {
  it('rejects a missing session', async () => {
    const res = await POST(
      new Request('https://kernel.test/api/balance/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: 'x', amount: 10, service: 'coffee', type: 'topup' }),
      }) as never,
    );
    expect(res.status).toBe(401);
  });

  it.each([stripeTopup, emtTopup])('also refuses bearer-only access at the user topup endpoints', async (route) => {
    const response = await route(jsonPostRequest('https://kernel.test/pay/api/topup',
      { amount: 25 }, { Authorization: `Bearer ${API_KEY}` }) as never);
    expect(response.status).toBe(401);
    expect(state.insertCalls).toHaveLength(0);
    expect(state.checkout).not.toHaveBeenCalled();
  });

  it('creates a pending EMT topup with a user session without crediting a balance', async () => {
    const response = await emtTopup(makeRequest({ amount: 25 }) as never);
    expect(response.status).toBe(200);
    expect(state.insertCalls).toHaveLength(1);
    expect(state.insertCalls[0].values).toMatchObject({ toDid: 'did:imajin:x', service: 'emt', status: 'pending' });
  });

  it.each([API_KEY, 'app-service-token', 'delegated-app-token', 'user-bearer'])('rejects bearer-only %s', async (token) => {
    const res = await POST(jsonPostRequest('https://kernel.test/api/balance/topup',
      { did: 'did:imajin:x', amount: 10, service: 'events', type: 'topup' },
      { Authorization: `Bearer ${token}` }) as never);
    expect(res.status).toBe(401);
    expect(state.insertCalls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects another identity even with a user session', async () => {
    const res = await POST(makeRequest({ did: 'did:imajin:other', amount: 25, service: 'events', type: 'topup' }) as never);
    expect(res.status).toBe(403);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('rejects a non-positive amount', async () => {
    const res = await POST(makeRequest({ did: 'did:imajin:x', amount: -1, service: 'coffee', type: 'topup' }) as never);
    expect(res.status).toBe(400);
  });

  it('initiates existing Stripe checkout and never credits a balance from caller input', async () => {
    const res = await POST(makeRequest({ did: 'did:imajin:x', amount: 25, service: 'coffee', type: 'topup' }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.test', sessionId: 'cs_topup' });
    expect(state.checkout).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ buyerDid: 'did:imajin:x', topupAmount: '25' }),
    }));
    expect(state.insertCalls).toHaveLength(1);
    expect(state.insertCalls[0].values).toMatchObject({ toDid: 'did:imajin:x', status: 'pending', amount: '25' });
    expect(state.insertCalls.some((call) => call.values.did)).toBe(false);
  });
});
