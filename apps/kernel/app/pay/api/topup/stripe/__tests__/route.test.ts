import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  keys: vi.fn(), nodeDid: vi.fn(), create: vi.fn(), construct: vi.fn(),
  auth: vi.fn(), insert: vi.fn(), rateLimit: vi.fn(), grossUp: vi.fn(),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDidFromConfig: h.nodeDid }));
vi.mock('@/src/lib/pay/rails/stripe-keys', () => ({
  resolveDidStripeKeys: h.keys, SellerNoCardRailError: class extends Error {},
}));
vi.mock('stripe', () => ({ default: class {
  constructor(key: string) { h.construct(key); }
  checkout = { sessions: { create: h.create } };
} }));
vi.mock('@/src/db', () => ({ db: { insert: () => ({ values: h.insert }) }, transactions: {} }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'tx_topup' }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({ 'Access-Control-Allow-Origin': '*' }), corsOptions: vi.fn() }));
vi.mock('@imajin/auth', () => ({ requireAuth: h.auth, resolveActingDid: (identity: { id: string }) => identity.id }));
vi.mock('@imajin/config', () => ({
  getClientIP: () => '127.0.0.1', rateLimit: h.rateLimit, buildPublicUrlAbsolute: () => 'https://pay.test',
}));
vi.mock('@imajin/fair', () => ({ grossUpForProcessorFee: h.grossUp }));
vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (...args: unknown[]) => unknown) => (request: unknown) =>
    handler(request, { log: { info: vi.fn() } }),
}));
import { SellerNoCardRailError } from '@/src/lib/pay/rails/stripe-keys';
import { POST } from '../route';

function request(body: unknown = { amount: 25 }): NextRequest {
  return new NextRequest('https://pay.test/pay/api/topup/stripe', { method: 'POST', body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.keys.mockResolvedValue({ secretKey: 'sk_test_fake' });
  h.nodeDid.mockResolvedValue('did:imajin:node');
  h.auth.mockResolvedValue({ identity: { id: 'did:imajin:buyer', handle: 'buyer' } });
  h.create.mockResolvedValue({ id: 'cs_topup', url: 'https://checkout.test' });
  h.rateLimit.mockReturnValue({ limited: false });
  h.grossUp.mockReturnValue(2600);
});

describe('node-owned Stripe topup', () => {
  it('charges with the node sealed key and carries the transaction reference onto the PaymentIntent', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.test', sessionId: 'cs_topup' });
    expect(h.keys).toHaveBeenCalledWith('did:imajin:node');
    expect(h.construct).toHaveBeenCalledWith('sk_test_fake');
    expect(h.keys).not.toHaveBeenCalledWith('did:imajin:buyer');
    const params = h.create.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: 'payment', success_url: expect.stringContaining('/topup/success'),
      metadata: { buyerDid: 'did:imajin:buyer', nodeDid: 'did:imajin:node', pay_transaction_id: 'tx_topup' },
    });
    expect(params.payment_intent_data.metadata).toEqual(params.metadata);
    expect(params.line_items[0].price_data.unit_amount).toBe(2500);
    expect(h.insert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'tx_topup', amount: '25', toDid: 'did:imajin:buyer', status: 'pending',
      externalRef: 'cs_topup', rail: 'stripe',
    }));
  });

  it('charges the grossed-up amount without increasing the buyer credit', async () => {
    await POST(request({ amount: 25, absorbFees: false }));
    expect(h.grossUp).toHaveBeenCalledWith('stripe', 2500);
    expect(h.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(2600);
    expect(h.insert.mock.calls[0][0]).toMatchObject({ amount: '25', metadata: { chargeAmountCents: '2600' } });
  });

  it('returns a clear 503 without charging or writing when the node connector is missing', async () => {
    h.keys.mockRejectedValue(new SellerNoCardRailError());
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual({
      error: 'Card rail not configured for this node', code: 'NODE_CARD_RAIL_NOT_CONFIGURED',
    });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each([null, '25', -1, 19.99])('rejects invalid amount %s before resolving credentials', async (amount) => {
    expect((await POST(request({ amount }))).status).toBe(400);
    expect(h.keys).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON before resolving credentials', async () => {
    const response = await POST(new NextRequest('https://pay.test', { method: 'POST', body: '{' }));
    expect(response.status).toBe(400);
    expect(h.keys).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request before resolving credentials', async () => {
    h.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await POST(request())).status).toBe(401);
    expect(h.keys).not.toHaveBeenCalled();
  });

  it('rate limits before auth or key lookup', async () => {
    h.rateLimit.mockReturnValue({ limited: true, retryAfter: 10 });
    expect((await POST(request())).status).toBe(429);
    expect(h.auth).not.toHaveBeenCalled();
    expect(h.keys).not.toHaveBeenCalled();
  });

  it('propagates a vault outage without attempting a platform fallback', async () => {
    h.keys.mockRejectedValue(new Error('vault unavailable'));
    await expect(POST(request())).rejects.toThrow('vault unavailable');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });
});
