/**
 * Tests for apps/coffee/app/api/checkout/route.ts
 *
 * This route had no prior coverage; added alongside the #2137 PAY_SERVICE_URL
 * fallback fix to raise new-code coverage. Exercises the rate-limit guard,
 * the minimum-amount validation, a failing pay-service call, and the success
 * path — each of which touches the module-level PAY_SERVICE_URL constant
 * corrected in this PR (stale `:3004` fallback -> kernel-prefixed `:3000/pay`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: mocks.rateLimitMock,
  getClientIP: vi.fn(() => '127.0.0.1'),
  buildPublicUrlAbsolute: vi.fn(() => 'https://coffee.test'),
}));

import { POST } from '../route';

function makeRequest(body: Record<string, unknown>): Parameters<typeof POST>[0] {
  return new Request('https://coffee.test/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

const VALID_BODY = { amount: 1000, recurring: false, joinMailingList: false };

describe('POST /api/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimitMock.mockReturnValue({ limited: false, retryAfter: 0 });
    vi.stubGlobal('fetch', mocks.fetchMock);
  });

  it('returns 429 when rate limited, without calling the pay service', async () => {
    mocks.rateLimitMock.mockReturnValue({ limited: true, retryAfter: 30 });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(429);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an amount below the $5 minimum', async () => {
    const res = await POST(makeRequest({ amount: 100 }));

    expect(res.status).toBe(400);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 500 and does not leak upstream error details when the pay service checkout call fails', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, text: async () => 'Stripe error' });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to create checkout');
    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    const [url] = mocks.fetchMock.mock.calls[0];
    expect(url).toContain('/api/checkout');
    expect(url).not.toContain('/pay/pay/');
  });

  it('returns the checkout URL on success and targets the documented /api/checkout path', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ url: 'https://checkout.example/session_1' }) });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://checkout.example/session_1');

    const [, init] = mocks.fetchMock.mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.mode).toBe('payment');
    expect(sentBody.currency).toBe('USD');
  });

  it('returns 500 when the request body cannot be parsed', async () => {
    const badRequest = new Request('https://coffee.test/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    }) as Parameters<typeof POST>[0];

    const res = await POST(badRequest);

    expect(res.status).toBe(500);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });
});
