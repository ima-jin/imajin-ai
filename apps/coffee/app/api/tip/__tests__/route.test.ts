/**
 * Tests for apps/coffee/app/api/tip/route.ts
 *
 * This route had no prior coverage; added alongside the #2137 PAY_SERVICE_URL
 * fallback fix to raise new-code coverage. Exercises the validation guards,
 * the Stripe tip path's pay-service call (success and failure), and the
 * Solana tip path — all of which touch the module-level PAY_SERVICE_URL
 * constant corrected in this PR (stale `:3004` fallback -> kernel-prefixed
 * `:3000/pay`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const valuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  return {
    valuesMock,
    insertMock,
    findFirstMock: vi.fn(),
    rateLimitMock: vi.fn(),
    requireAuthMock: vi.fn(),
    publishMock: vi.fn(),
    fetchMock: vi.fn(),
  };
});

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/db', () => ({
  db: { insert: mocks.insertMock, query: { coffeePages: { findFirst: mocks.findFirstMock } } },
  tips: {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@imajin/bus', () => ({
  publish: mocks.publishMock,
}));

vi.mock('@/lib/utils', () => ({
  jsonResponse: (data: unknown, status = 200) => Response.json(data, { status }),
  errorResponse: (error: string, status = 400) => Response.json({ error }, { status }),
  generateId: (prefix: string) => `${prefix}_test123`,
}));

vi.mock('@imajin/config', () => ({
  rateLimit: mocks.rateLimitMock,
  getClientIP: vi.fn(() => '127.0.0.1'),
  buildPublicUrl: vi.fn(() => 'https://coffee.test'),
}));

import { POST } from '../route';

function makeRequest(body: Record<string, unknown>): Parameters<typeof POST>[0] {
  return new Request('https://coffee.test/api/tip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const STRIPE_PAGE = {
  id: 'page_1',
  did: 'did:imajin:creator',
  handle: 'creator',
  title: 'Creator Page',
  isPublic: true,
  allowMessages: true,
  paymentMethods: { stripe: { enabled: true }, solana: { enabled: true, address: 'sol-address-1' } },
};

const VALID_STRIPE_BODY = { pageHandle: 'creator', amount: 500, paymentMethod: 'stripe' };

describe('POST /api/tip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimitMock.mockReturnValue({ limited: false, retryAfter: 0 });
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    mocks.valuesMock.mockResolvedValue(undefined);
    mocks.findFirstMock.mockResolvedValue(STRIPE_PAGE);
    vi.stubGlobal('fetch', mocks.fetchMock);
  });

  it('returns 429 when rate limited', async () => {
    mocks.rateLimitMock.mockReturnValue({ limited: true, retryAfter: 15 });

    const res = await POST(makeRequest(VALID_STRIPE_BODY));

    expect(res.status).toBe(429);
  });

  it('rejects a request missing pageHandle', async () => {
    const res = await POST(makeRequest({ amount: 500, paymentMethod: 'stripe' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/pageHandle/);
  });

  it('returns 404 when the coffee page is not found', async () => {
    mocks.findFirstMock.mockResolvedValue(undefined);

    const res = await POST(makeRequest(VALID_STRIPE_BODY));

    expect(res.status).toBe(404);
  });

  it('rejects a stripe tip when stripe is not enabled on the page', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...STRIPE_PAGE, paymentMethods: { stripe: { enabled: false } } });

    const res = await POST(makeRequest(VALID_STRIPE_BODY));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Card payments not enabled/);
  });

  it('creates a pending stripe tip and returns the checkout URL on success', async () => {
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'cs_test_1', url: 'https://checkout.example/cs_test_1' }),
    });

    const res = await POST(makeRequest(VALID_STRIPE_BODY));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://checkout.example/cs_test_1');
    expect(body.paymentMethod).toBe('stripe');

    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    const [url] = mocks.fetchMock.mock.calls[0];
    expect(url).toContain('/api/checkout');
    expect(url).not.toContain('/pay/pay/');
    expect(mocks.valuesMock).toHaveBeenCalledWith(expect.objectContaining({ paymentMethod: 'stripe', status: 'pending' }));
  });

  it('returns 500 when the pay service checkout call fails for a stripe tip', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, text: async () => 'card declined' });

    const res = await POST(makeRequest(VALID_STRIPE_BODY));

    expect(res.status).toBe(500);
    expect(mocks.valuesMock).not.toHaveBeenCalled();
  });

  it('creates a pending solana tip without calling the pay service', async () => {
    const res = await POST(makeRequest({ pageHandle: 'creator', amount: 500, paymentMethod: 'solana' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.solanaAddress).toBe('sol-address-1');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the request body cannot be parsed', async () => {
    const badRequest = new Request('https://coffee.test/api/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    }) as unknown as Parameters<typeof POST>[0];

    const res = await POST(badRequest);

    expect(res.status).toBe(500);
  });
});
