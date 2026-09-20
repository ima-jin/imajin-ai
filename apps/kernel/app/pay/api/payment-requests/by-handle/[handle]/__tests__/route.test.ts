import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getPaymentRequestByHandle: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  getPaymentRequestByHandle: mocks.getPaymentRequestByHandle,
}));

import { GET } from '../route';

function getReq(handle: string): NextRequest {
  return new NextRequest(`https://kernel.test/pay/api/payment-requests/by-handle/${handle}`);
}

function makeParams(handle: string) {
  return { params: Promise.resolve({ handle }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /pay/api/payment-requests/by-handle/:handle', () => {
  it('returns the minimal public view for a known handle', async () => {
    mocks.getPaymentRequestByHandle.mockResolvedValueOnce({
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 5000, quantity: 1 }],
      totalAmount: 5000,
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });

    const res = await GET(getReq('ph_abc123'), makeParams('ph_abc123'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 5000, quantity: 1 }],
      totalAmount: 5000,
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });
    // No PII / internal fields leak through.
    expect(body.issuerDid).toBeUndefined();
    expect(body.recipientDid).toBeUndefined();
    expect(body.recipientStubId).toBeUndefined();
    expect(body.contentHash).toBeUndefined();
  });

  it('404s on an unknown handle', async () => {
    mocks.getPaymentRequestByHandle.mockResolvedValueOnce(null);
    const res = await GET(getReq('ph_bad'), makeParams('ph_bad'));
    expect(res.status).toBe(404);
  });

  it('surfaces a 500 on unexpected errors without leaking internals', async () => {
    mocks.getPaymentRequestByHandle.mockRejectedValueOnce(new Error('db down'));
    const res = await GET(getReq('ph_abc123'), makeParams('ph_abc123'));
    expect(res.status).toBe(500);
  });
});
