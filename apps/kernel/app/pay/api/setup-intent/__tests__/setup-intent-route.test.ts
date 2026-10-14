import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  registry: vi.fn(),
  select: vi.fn(),
  loadKey: vi.fn(),
  grant: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: mocks.verifyToken }));
vi.mock('@/src/db', () => ({
  registryApps: { appDid: 'appDid', status: 'status', approvedServiceScopes: 'approved' },
  db: { select: mocks.select },
}));
vi.mock('drizzle-orm', () => ({ eq: (field: unknown, value: unknown) => ({ field, value }) }));
vi.mock('@/src/lib/stripe/connector-core', () => ({
  STRIPE_EVENTS_SCOPE: 'stripe:events',
  stripe: { loadSealedCredentials: mocks.loadKey, resolveActiveGrant: mocks.grant },
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://events.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
// Any regression to the platform SDK fails immediately, not merely assertions.
vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => { throw new Error('Platform Stripe is forbidden'); },
}));

import { POST as create } from '../route';
import { POST as verify } from '../verify/route';

const APP = 'did:imajin:events-app';
const OTHER_APP = 'did:imajin:other-app';
const BUYER = 'did:imajin:buyer';
const SELLER = 'did:imajin:seller';
const binding = { pledgeId: 'pledge_1', eventId: 'event_1', buyerDid: BUYER, sellerDid: SELLER, amount: 5000, currency: 'CAD' };
const verification = { ...binding, setupIntentId: 'seti_123', customerId: 'cus_123' };
const metadata = { ...binding, amount: '5000', appDid: APP };
const customer = () => ({ id: 'cus_123', metadata: { buyerDid: BUYER, did: BUYER } });
const paymentMethod = () => ({ id: 'pm_123', customer: 'cus_123' });
const intent = () => ({
  id: 'seti_123',
  status: 'succeeded',
  customer: customer(),
  payment_method: paymentMethod(),
  metadata: { ...metadata },
  client_secret: 'seti_123_secret_test',
});

function request(body: unknown, token: string | null = 'valid', raw?: string) {
  return new NextRequest('https://kernel.test/pay/api/setup-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function expectFailure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: expect.any(String), code });
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://events.test');
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verifyToken.mockResolvedValue({ azp: APP, sub: APP, scope: 'pay:setup-intent', isServiceToken: true });
  mocks.registry.mockResolvedValue([{ status: 'active', approved: ['pay:setup-intent'] }]);
  mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: mocks.registry }) }) });
  mocks.loadKey.mockResolvedValue({ apiKey: 'rk_test_seller' });
  mocks.grant.mockResolvedValue(true);
  mocks.fetch.mockImplementation(async () => reply(intent()));
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('registered-app BYO SetupIntent creation', () => {
  it('creates a buyer-bound customer and an app/pledge-bound intent on only the seller key', async () => {
    mocks.fetch.mockResolvedValueOnce(reply(customer())).mockResolvedValueOnce(reply({ ...intent(), customer: 'cus_123' }));
    const response = await create(request({
      ...binding,
      currency: 'cad',
      metadata: { appDid: OTHER_APP, buyerDid: 'did:imajin:forged', pledgeId: 'forged', amount: '1', extra: 'ignored' },
      appDid: OTHER_APP,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clientSecret: 'seti_123_secret_test', setupIntentId: 'seti_123', customerId: 'cus_123' });
    expect(mocks.loadKey).toHaveBeenCalledWith(SELLER);
    expect(mocks.grant).toHaveBeenCalledWith(SELLER, 'stripe:events');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const calls = mocks.fetch.mock.calls;
    expect(calls[0][0]).toBe('https://api.stripe.com/v1/customers');
    expect(calls[1][0]).toBe('https://api.stripe.com/v1/setup_intents');
    const customerForm = new URLSearchParams(calls[0][1].body);
    expect(customerForm.get('metadata[did]')).toBe(BUYER);
    expect(customerForm.get('metadata[buyerDid]')).toBe(BUYER);
    const form = new URLSearchParams(calls[1][1].body);
    for (const [field, value] of Object.entries(metadata)) expect(form.get(`metadata[${field}]`)).toBe(String(value));
    expect(form.get('metadata[extra]')).toBeNull();
    expect(form.get('usage')).toBe('off_session');
    expect(form.get('customer')).toBe('cus_123');
    expect(form.get('payment_method_types[0]')).toBe('card');
    for (const [, options] of calls) {
      expect(options.headers.Authorization).toBe('Bearer rk_test_seller');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.redirect).toBe('error');
      expect(options.cache).toBe('no-store');
    }
  });

  it.each([
    ['missing customer ID', {}],
    ['invalid customer ID', { ...customer(), id: '../cus_123' }],
    ['wrong customer buyer', { ...customer(), metadata: { did: 'did:imajin:other' } }],
    ['deleted customer', { ...customer(), deleted: true }],
  ])('refuses %s before creating an intent', async (_label, body) => {
    mocks.fetch.mockResolvedValueOnce(reply(body));
    const response = await create(request(binding));
    expect([403, 503]).toContain(response.status);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no secret', { ...intent(), client_secret: null }],
    ['bad secret', { ...intent(), client_secret: 'other_secret' }],
    ['no intent ID', { ...intent(), id: null }],
    ['wrong customer', { ...intent(), customer: 'cus_other' }],
    ['missing binding', { ...intent(), metadata: {} }],
    ['wrong app binding', { ...intent(), metadata: { ...metadata, appDid: OTHER_APP } }],
  ])('fails closed for creation response with %s', async (_label, body) => {
    mocks.fetch.mockResolvedValueOnce(reply(customer())).mockResolvedValueOnce(reply(body));
    await expectFailure(await create(request(binding)), 503, 'SETUP_INTENT_UNAVAILABLE');
  });
});

describe('read-only verification', () => {
  it('returns the exact verified contract; repeated verification only performs reads', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await verify(request(verification));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ verified: true, ...verification, paymentMethodId: 'pm_123' });
    }
    expect(mocks.loadKey).toHaveBeenCalledTimes(2);
    expect(mocks.registry).toHaveBeenCalledTimes(2);
    for (const [url, options] of mocks.fetch.mock.calls) {
      expect(url).toBe('https://api.stripe.com/v1/setup_intents/seti_123?expand[]=customer&expand[]=payment_method');
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
    }
  });

  it('retrieves unexpanded customer and payment method on the same seller key', async () => {
    mocks.fetch.mockResolvedValueOnce(reply({ ...intent(), customer: 'cus_123', payment_method: 'pm_123' }))
      .mockResolvedValueOnce(reply(customer())).mockResolvedValueOnce(reply(paymentMethod()));
    expect((await verify(request(verification))).status).toBe(200);
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.stripe.com/v1/setup_intents/seti_123?expand[]=customer&expand[]=payment_method',
      'https://api.stripe.com/v1/customers/cus_123',
      'https://api.stripe.com/v1/payment_methods/pm_123',
    ]);
    for (const [, options] of mocks.fetch.mock.calls) expect(options.headers.Authorization).toBe('Bearer rk_test_seller');
  });

  it.each(Object.keys(metadata))('refuses forged %s metadata', async (field) => {
    mocks.fetch.mockResolvedValue(reply({ ...intent(), metadata: { ...metadata, [field]: 'forged' } }));
    await expectFailure(await verify(request(verification)), 403, 'setup_intent_binding_mismatch');
  });

  it.each(['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'canceled'])('refuses %s intent', async (status) => {
    mocks.fetch.mockResolvedValue(reply({ ...intent(), status }));
    await expectFailure(await verify(request(verification)), 409, 'setup_intent_not_succeeded');
  });

  it.each([
    ['legacy intent', { ...intent(), metadata: { did: BUYER, amount: '5000', currency: 'CAD' } }],
    ['metadata absent', { ...intent(), metadata: null }],
    ['intent ID', { ...intent(), id: 'seti_other' }],
    ['customer ID', { ...intent(), customer: 'cus_other' }],
    ['buyer', { ...intent(), customer: { ...customer(), metadata: { did: 'did:imajin:other' } } }],
    ['conflicting buyerDid', { ...intent(), customer: { ...customer(), metadata: { did: BUYER, buyerDid: 'did:imajin:other' } } }],
    ['conflicting did', { ...intent(), customer: { ...customer(), metadata: { buyerDid: BUYER, did: 'did:imajin:other' } } }],
    ['deleted customer', { ...intent(), customer: { ...customer(), deleted: true } }],
    ['missing customer metadata', { ...intent(), customer: { id: 'cus_123' } }],
    ['payment method customer', { ...intent(), payment_method: { ...paymentMethod(), customer: 'cus_other' } }],
    ['unattached payment method', { ...intent(), payment_method: { ...paymentMethod(), customer: null } }],
  ])('refuses mismatched %s', async (_label, body) => {
    mocks.fetch.mockResolvedValue(reply(body));
    await expectFailure(await verify(request(verification)), 403, 'setup_intent_binding_mismatch');
  });

  it('another active app cannot verify a pledge bound to the creating app', async () => {
    mocks.verifyToken.mockResolvedValue({ azp: OTHER_APP, sub: OTHER_APP, scope: 'pay:setup-intent', isServiceToken: true });
    await expectFailure(await verify(request(verification)), 403, 'setup_intent_binding_mismatch');
  });

  it.each([{ did: BUYER }, { buyerDid: BUYER }])('accepts the unambiguous customer vocabulary %j', async (customerMetadata) => {
    mocks.fetch.mockResolvedValue(reply({ ...intent(), customer: { ...customer(), metadata: customerMetadata } }));
    expect((await verify(request(verification))).status).toBe(200);
  });

  it('rejects a retrieved payment method whose response ID changed', async () => {
    mocks.fetch.mockResolvedValueOnce(reply({ ...intent(), payment_method: 'pm_123' }))
      .mockResolvedValueOnce(reply({ ...paymentMethod(), id: 'pm_other' }));
    await expectFailure(await verify(request(verification)), 403, 'setup_intent_binding_mismatch');
  });

  it.each([
    { ...customer(), id: 'cus_other' },
    { ...customer(), deleted: true },
  ])('rejects missing or deleted retrieved customer %j', async (retrievedCustomer) => {
    mocks.fetch.mockResolvedValueOnce(reply({ ...intent(), customer: 'cus_123' }))
      .mockResolvedValueOnce(reply(retrievedCustomer));
    await expectFailure(await verify(request(verification)), 403, 'setup_intent_binding_mismatch');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts a payment method with an expanded matching customer reference', async () => {
    mocks.fetch.mockResolvedValue(reply({ ...intent(), payment_method: { ...paymentMethod(), customer: customer() } }));
    expect((await verify(request(verification))).status).toBe(200);
  });

  it.each([null, 'pm_../escaped', {}, 17])('refuses invalid payment method %j', async (method) => {
    mocks.fetch.mockResolvedValue(reply({ ...intent(), payment_method: method }));
    await expectFailure(await verify(request(verification)), 503, 'SETUP_INTENT_UNAVAILABLE');
  });
});

describe.each([['create', create, binding], ['verify', verify, verification]] as const)('%s authorization and availability', (_name, handler, body) => {
  it.each([null, 'expired', 'shared-pay-key', 'session-token'])('refuses absent/invalid credential %s', async (token) => {
    mocks.verifyToken.mockResolvedValue(null);
    await expectFailure(await handler(request(body, token)), 401, 'SETUP_APP_UNAUTHORIZED');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['delegated token', { azp: APP, scope: 'pay:setup-intent', isServiceToken: false }],
    ['missing app identity', { scope: 'pay:setup-intent', isServiceToken: true }],
    ['settle-only token', { azp: APP, scope: 'pay:settle', isServiceToken: true }],
  ])('refuses %s', async (_label, claims) => {
    mocks.verifyToken.mockResolvedValue(claims);
    await expectFailure(await handler(request(body)), 403, 'SETUP_APP_UNAUTHORIZED');
    expect(mocks.loadKey).not.toHaveBeenCalled();
  });

  it.each([
    { rows: [] },
    { rows: [{ status: 'revoked', approved: ['pay:setup-intent'] }] },
    { rows: [{ status: 'active', approved: [] }] },
    { rows: [{ status: 'active', approved: null }] },
    { rows: [{ status: 'active', approved: ['pay:settle'] }] },
  ])('rechecks current registry and scope approval %j', async ({ rows }) => {
    mocks.registry.mockResolvedValue(rows);
    await expectFailure(await handler(request(body)), 403, 'SETUP_APP_UNAUTHORIZED');
    expect(mocks.loadKey).not.toHaveBeenCalled();
  });

  it('stops accepting an outstanding token immediately after approval revocation', async () => {
    mocks.fetch.mockResolvedValueOnce(reply(customer())).mockResolvedValue(reply(intent()));
    expect((await create(request(binding))).status).toBe(200);
    mocks.registry.mockResolvedValue([{ status: 'active', approved: [] }]);
    const before = mocks.fetch.mock.calls.length;
    await expectFailure(await handler(request(body)), 403, 'SETUP_APP_UNAUTHORIZED');
    expect(mocks.fetch).toHaveBeenCalledTimes(before);
  });

  it('rechecks app registration after an already-successful verification', async () => {
    expect((await verify(request(verification))).status).toBe(200);
    mocks.registry.mockResolvedValue([{ status: 'revoked', approved: ['pay:setup-intent'] }]);
    await expectFailure(await handler(request(body)), 403, 'SETUP_APP_UNAUTHORIZED');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { apiKey: '' }])('fails closed when seller key is absent %j', async (credentials) => {
    mocks.loadKey.mockResolvedValue(credentials);
    await expectFailure(await handler(request(body)), 503, 'SELLER_NO_CARD_RAIL');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fails closed for revoked seller Stripe event grant', async () => {
    mocks.grant.mockResolvedValue(false);
    await expectFailure(await handler(request(body)), 503, 'SELLER_NO_CARD_RAIL');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 429, 500, 503])('maps Stripe HTTP %s to typed unavailable without leaking details', async (status) => {
    mocks.fetch.mockResolvedValue(reply({ error: { message: 'sensitive upstream detail' } }, status));
    await expectFailure(await handler(request(body)), 503, 'SETUP_INTENT_UNAVAILABLE');
  });

  it('returns typed 404 for unknown resource on seller account', async () => {
    mocks.fetch.mockResolvedValue(reply({}, 404));
    await expectFailure(await handler(request(body)), 404, 'setup_intent_resource_not_found');
  });

  it.each([null, [], 'bad json'])('rejects malformed Stripe JSON %j', async (value) => {
    mocks.fetch.mockResolvedValue(reply(value));
    await expectFailure(await handler(request(body)), 503, 'SETUP_INTENT_UNAVAILABLE');
  });

  it('rejects non-JSON upstream response', async () => {
    mocks.fetch.mockResolvedValue(new Response('<html>proxy error</html>'));
    await expectFailure(await handler(request(body)), 503, 'SETUP_INTENT_UNAVAILABLE');
  });

  it('bounds requests and maps abort/network errors to unavailable', async () => {
    mocks.fetch.mockRejectedValue(new DOMException('aborted', 'TimeoutError'));
    await expectFailure(await handler(request(body)), 503, 'SETUP_INTENT_UNAVAILABLE');
    expect(mocks.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed for registry/database outage', async () => {
    mocks.registry.mockRejectedValue(new Error('database offline'));
    await expectFailure(await handler(request(body)), 503, 'SETUP_INTENT_UNAVAILABLE');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fails closed for vault outage', async () => {
    mocks.loadKey.mockRejectedValue(new Error('vault offline'));
    await expectFailure(await handler(request(body)), 503, 'SETUP_INTENT_UNAVAILABLE');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed request JSON', async () => {
    await expectFailure(await handler(request(null, 'valid', '{')), 400, 'setup_intent_invalid_request');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    null, [], 'string',
    { ...body, pledgeId: '' }, { ...body, eventId: {} },
    { ...body, pledgeId: '../path' }, { ...body, buyerDid: 'not-a-did' },
    { ...body, sellerDid: BUYER + '\n' }, { ...body, amount: 0 },
    { ...body, amount: -50 }, { ...body, amount: 50.5 }, { ...body, amount: '5000' },
    { ...body, amount: Number.MAX_SAFE_INTEGER }, { ...body, currency: 'CA' },
    { ...body, currency: ' CAD' }, { ...body, pledgeId: 'x'.repeat(201) },
  ])('validates untrusted JSON fields %j', async (invalid) => {
    await expectFailure(await handler(request(invalid)), 400, 'setup_intent_invalid_request');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('verify IDs cannot escape their Stripe path segment', () => {
  it.each([
    { ...verification, setupIntentId: 'seti_123/../other' },
    { ...verification, customerId: 'cus_123?expand[]=secret' },
    { ...verification, setupIntentId: 'seti_123%2fother' },
    { ...verification, customerId: null },
  ])('rejects %j', async (body) => {
    await expectFailure(await verify(request(body)), 400, 'setup_intent_invalid_request');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
