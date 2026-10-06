/**
 * Tests for POST /pay/api/charge-pledges.
 *
 * Pledges are charged off-session through Stripe one at a time, in order.
 * One pledge failing (missing payment method, Stripe error, 3DS required)
 * is recorded in `results` and never stops the remaining pledges.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const h = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return { withLogger: withLoggerPassthrough() };
});

vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false }),
  getClientIP: () => '127.0.0.1',
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ paymentIntents: { create: h.create } }),
}));

import { POST } from '../route';

const KEY = 'test-pay-service-key';

function pledge(id: string, overrides: Record<string, unknown> = {}) {
  return {
    pledgeId: id,
    amount: 1000,
    currency: 'CAD',
    stripeCustomerId: `cus_${id}`,
    stripePaymentMethodId: `pm_${id}`,
    ...overrides,
  };
}

function request(pledges: unknown[]) {
  return jsonPostRequest(
    'https://kernel.test/pay/api/charge-pledges',
    { eventId: 'evt_1', pledges },
    { authorization: `Bearer ${KEY}` },
  );
}

beforeEach(() => {
  h.create.mockReset();
  process.env.PAY_SERVICE_API_KEY = KEY;
});

describe('POST /pay/api/charge-pledges', () => {
  it('charges pledges one at a time, in order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    h.create.mockImplementation(async (args: { metadata: { pledgeId: string } }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(args.metadata.pledgeId);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { status: 'succeeded' };
    });

    const res = await POST(request([pledge('p1'), pledge('p2'), pledge('p3')]) as never, {} as never);
    const body = await res.json();

    expect(order).toEqual(['p1', 'p2', 'p3']);
    expect(maxInFlight).toBe(1);
    expect(body).toMatchObject({ charged: 3, failed: 0, total: 3 });
    expect(body.results.map((r: { pledgeId: string }) => r.pledgeId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('records a Stripe error for one pledge and still charges the rest', async () => {
    h.create
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockRejectedValueOnce(new Error('card_declined'))
      .mockResolvedValueOnce({ status: 'processing' });

    const res = await POST(request([pledge('p1'), pledge('p2'), pledge('p3')]) as never, {} as never);
    const body = await res.json();

    expect(h.create).toHaveBeenCalledTimes(3);
    expect(body).toMatchObject({ charged: 2, failed: 1, total: 3 });
    expect(body.results).toEqual([
      { pledgeId: 'p1', status: 'charged' },
      { pledgeId: 'p2', status: 'failed', error: 'card_declined' },
      { pledgeId: 'p3', status: 'charged' },
    ]);
  });

  it('fails a pledge with no payment method without calling Stripe, and keeps going', async () => {
    h.create.mockResolvedValue({ status: 'succeeded' });

    const res = await POST(
      request([pledge('p1', { stripePaymentMethodId: '' }), pledge('p2')]) as never,
      {} as never,
    );
    const body = await res.json();

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(body.results).toEqual([
      { pledgeId: 'p1', status: 'failed', error: 'Missing Stripe customer or payment method' },
      { pledgeId: 'p2', status: 'charged' },
    ]);
    expect(body).toMatchObject({ charged: 1, failed: 1 });
  });

  it('marks requires_action (3D Secure) as failed for off-session charges', async () => {
    h.create.mockResolvedValue({ status: 'requires_action' });

    const res = await POST(request([pledge('p1')]) as never, {} as never);
    const body = await res.json();

    expect(body.results).toEqual([
      { pledgeId: 'p1', status: 'failed', error: 'Payment requires additional authentication (3D Secure)' },
    ]);
  });

  it('rejects a request without the service API key', async () => {
    const res = await POST(
      jsonPostRequest('https://kernel.test/pay/api/charge-pledges', { eventId: 'evt_1', pledges: [pledge('p1')] }) as never,
      {} as never,
    );

    expect(res.status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });
});
