import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createPaymentRequestCheckoutSession: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth,
  resolveActingDid: (identity: { actingFor?: string; id: string }) => identity.actingFor ?? identity.id,
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

// NOT vi.importActual: the real module transitively imports '@/src/db',
// which requires DATABASE_URL to be set.
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({
  createPaymentRequestCheckoutSession: mocks.createPaymentRequestCheckoutSession,
}));
vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  isServiceError: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value && 'status' in value,
}));

import { POST } from '../route';

const ISSUER_DID = 'did:imajin:issuer';

function callCheckout(body: unknown, id = 'pr_1') {
  return POST(
    new NextRequest(`https://kernel.test/pay/api/payment-requests/${id}/checkout`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: ISSUER_DID } });
});

describe('POST /pay/api/payment-requests/:id/checkout', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await callCheckout({});
    expect(res.status).toBe(401);
    expect(mocks.createPaymentRequestCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects a non-string customer_email', async () => {
    const res = await callCheckout({ customer_email: 123 });
    expect(res.status).toBe(400);
    expect(mocks.createPaymentRequestCheckoutSession).not.toHaveBeenCalled();
  });

  it('delegates to the service and returns 200 with the session on success', async () => {
    mocks.createPaymentRequestCheckoutSession.mockResolvedValueOnce({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/cs_1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      reused: false,
    });
    const res = await callCheckout({ customer_email: 'buyer@example.com' });
    expect(res.status).toBe(200);
    expect(mocks.createPaymentRequestCheckoutSession).toHaveBeenCalledWith({
      id: 'pr_1',
      callerDid: ISSUER_DID,
      customerEmail: 'buyer@example.com',
    });
    const json = await res.json();
    expect(json).toMatchObject({ id: 'cs_1', reused: false });
  });

  it('maps a 409 status-conflict rejection through (not issued)', async () => {
    mocks.createPaymentRequestCheckoutSession.mockResolvedValueOnce({
      error: "cannot create a checkout session for a payment_request in status 'paid'",
      status: 409,
    });
    const res = await callCheckout({});
    expect(res.status).toBe(409);
  });

  it('maps a 400 rejection through (allow_on_platform false)', async () => {
    mocks.createPaymentRequestCheckoutSession.mockResolvedValueOnce({
      error: 'payment_request does not allow on-platform (Stripe) payment',
      status: 400,
    });
    const res = await callCheckout({});
    expect(res.status).toBe(400);
  });

  it('handles an empty request body', async () => {
    mocks.createPaymentRequestCheckoutSession.mockResolvedValueOnce({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/cs_1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      reused: false,
    });
    const res = await POST(
      new NextRequest('https://kernel.test/pay/api/payment-requests/pr_1/checkout', { method: 'POST' }),
      { params: Promise.resolve({ id: 'pr_1' }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.createPaymentRequestCheckoutSession).toHaveBeenCalledWith({
      id: 'pr_1',
      callerDid: ISSUER_DID,
      customerEmail: undefined,
    });
  });
});
