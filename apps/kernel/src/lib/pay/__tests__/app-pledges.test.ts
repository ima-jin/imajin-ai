import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { setupIntentMetadata } from '../setup-intent';

const h = vi.hoisted(() => ({
  keys: vi.fn(), client: vi.fn(), retrieve: vi.fn(), update: vi.fn(), create: vi.fn(),
  setups: new Map<string, Record<string, unknown>>(),
  payments: new Map<string, { id: string; status: string }>(),
  app: 'did:imajin:events', limited: false, verifiedCustomer: 'did:imajin:buyer',
  attachedCustomer: 'cus_buyer',
}));
vi.mock('@/src/db', () => { throw new Error('Pledge collection must not import the kernel database'); });
vi.mock('../rails/stripe-keys', () => ({
  resolveDidStripeKeys: h.keys,
  SellerNoCardRailError: class extends Error {
    readonly code = 'SELLER_NO_CARD_RAIL';
    constructor() { super('Seller card rail is unavailable'); }
  },
}));
vi.mock('../providers/seller-pledge-refund', () => ({ sellerPledgeRefundClient: h.client }));
vi.mock('../app-service-auth', () => ({
  authenticatePayApp: async (request: Request) => request.headers.has('authorization')
    ? { appDid: h.app } : { error: 'App-service token required', status: 401 },
}));
vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: h.limited, retryAfter: 10 }), getClientIP: () => '127.0.0.1',
}));
vi.mock('@imajin/logger', () => ({
  withLogger: (_name: string, handler: (request: NextRequest, context: unknown) => unknown) =>
    (request: NextRequest) => handler(request, { log: { error: vi.fn() } }),
}));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null) }));

import { POST } from '../../../../app/pay/api/charge-pledges/route';
import { chargeBoundPledge, loadAppPledges, pledgeFailure } from '../app-pledges';
import { SellerNoCardRailError } from '../rails/stripe-keys';

const SELLER = 'did:imajin:seller';
const OTHER = 'did:imajin:other';
const REF = { pledgeId: 'pledge1', setupIntentId: 'seti_one', sellerDid: SELLER };
const BINDING = { pledgeId: 'pledge1', eventId: 'event1', buyerDid: 'did:imajin:buyer', sellerDid: SELLER, amount: 1000, currency: 'CAD' };

function seed(setupIntentId = 'seti_one', binding = BINDING) {
  h.setups.set(setupIntentId, {
    id: setupIntentId, status: 'succeeded', customer: 'cus_buyer', payment_method: 'pm_saved',
    metadata: setupIntentMetadata(h.app, binding),
  });
}
function request(pledges: unknown[] = [REF], overrides = {}) {
  return new NextRequest('https://kernel.test/pay/api/charge-pledges', {
    method: 'POST', headers: { authorization: 'Bearer fake-app-token', 'content-type': 'application/json' },
    body: JSON.stringify({ eventId: 'event1', pledges, ...overrides }),
  });
}
function mutateMetadata(values: Record<string, string | undefined>) {
  const setup = h.setups.get('seti_one')!;
  const metadata = setup.metadata as Record<string, string>;
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined) delete metadata[field];
    else metadata[field] = value;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.setups.clear(); h.payments.clear(); h.app = 'did:imajin:events'; h.limited = false;
  h.verifiedCustomer = BINDING.buyerDid; h.attachedCustomer = 'cus_buyer';
  seed();
  h.keys.mockResolvedValue({ secretKey: 'rk_test_fake', publishableKey: 'pk_test_fake' });
  h.retrieve.mockImplementation(async (id: string) => structuredClone(h.setups.get(id)));
  h.update.mockImplementation(async (id: string, input: { metadata: Record<string, string> }) => {
    const setup = h.setups.get(id)!;
    setup.metadata = { ...setup.metadata as object, ...input.metadata };
    return structuredClone(setup);
  });
  h.create.mockImplementation(async (_input: unknown, options: { idempotencyKey: string }) => {
    if (!h.payments.has(options.idempotencyKey)) h.payments.set(options.idempotencyKey, { id: 'pi_one', status: 'succeeded' });
    return h.payments.get(options.idempotencyKey);
  });
  h.client.mockReturnValue({
    setupIntents: { retrieve: h.retrieve, update: h.update }, paymentIntents: { create: h.create },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/^https:\/\/api\.stripe\.com\/v1\/setup_intents\/seti_/);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rk_test_fake');
    const id = url.split('/setup_intents/')[1].split('?')[0];
    const setup = structuredClone(h.setups.get(id));
    if (!setup) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({
      ...setup,
      customer: { id: 'cus_buyer', metadata: { buyerDid: h.verifiedCustomer, did: h.verifiedCustomer } },
      payment_method: { id: 'pm_saved', customer: h.attachedCustomer },
    }));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('seller-account pledge authority', () => {
  it('charges a matching #2788 binding with no kernel pledge row and ignores caller amount/card fields', async () => {
    const response = await POST(request([{ ...REF, amount: 99999, stripeCustomerId: 'cus_attacker', stripePaymentMethodId: 'pm_attacker' }]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ charged: 1, failed: 0 });
    expect(h.keys.mock.calls.every(([did]) => did === SELLER)).toBe(true);
    expect(h.client).toHaveBeenCalledWith('rk_test_fake');
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 1000, currency: 'cad', customer: 'cus_buyer', payment_method: 'pm_saved',
      metadata: expect.objectContaining({ sellerDid: SELLER, setupIntentId: REF.setupIntentId, appDid: h.app }),
    }), { idempotencyKey: expect.stringMatching(/^pledge-charge:[a-f0-9]{64}$/), timeout: 10_000, maxNetworkRetries: 0 });
    expect(h.update).toHaveBeenCalledWith('seti_one', expect.any(Object), { timeout: 10_000, maxNetworkRetries: 0 });
    expect(h.retrieve).toHaveBeenCalledWith('seti_one', {}, { timeout: 10_000, maxNetworkRetries: 0 });
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.create.mock.invocationCallOrder[0]);
  });
  it.each(['sellerDid', 'pledgeId', 'eventId', 'appDid'])('rejects a mismatched %s binding with 403', async (field) => {
    mutateMetadata({ [field]: 'did:imajin:mismatch' });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PLEDGE_BINDING_MISMATCH' });
    expect(h.create).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });
  it('uses the requested seller account but refuses a different seller in its metadata', async () => {
    const response = await POST(request([{ ...REF, sellerDid: OTHER }]));
    expect(response.status).toBe(403); expect(h.keys).toHaveBeenCalledWith(OTHER);
    expect(h.create).not.toHaveBeenCalled();
  });
  it.each(['sellerDid', 'pledgeId', 'eventId', 'appDid', 'buyerDid', 'amount', 'currency'])(
    'rejects missing %s binding with 403', async (field) => {
      mutateMetadata({ [field]: undefined });
      expect((await POST(request())).status).toBe(403);
      expect(h.create).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    },
  );
  it.each([null, {}])('rejects missing metadata %j with 403', async (metadata) => {
    h.setups.get('seti_one')!.metadata = metadata;
    expect((await POST(request())).status).toBe(403); expect(h.create).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', 'NaN', '1.2'])('rejects invalid recorded amount %s', async (amount) => {
    mutateMetadata({ amount });
    expect((await POST(request())).status).toBe(403); expect(h.create).not.toHaveBeenCalled();
  });
  it('checks buyer/customer attachment using the existing read-only verification', async () => {
    h.verifiedCustomer = OTHER;
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'setup_intent_binding_mismatch' });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('rejects a payment method attached to the wrong customer', async () => {
    h.attachedCustomer = 'cus_wrong';
    expect((await POST(request())).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('rejects incomplete setups with 409', async () => {
    h.setups.get('seti_one')!.status = 'requires_payment_method';
    expect((await POST(request())).status).toBe(409); expect(h.create).not.toHaveBeenCalled();
  });
  it('rejects missing customer before verification or charging', async () => {
    h.setups.get('seti_one')!.customer = null;
    expect((await POST(request())).status).toBe(403); expect(h.create).not.toHaveBeenCalled();
  });
  it.each([
    { pledgeId: 'p', setupIntentId: 'seti_one' }, null,
    { ...REF, sellerDid: '' }, { ...REF, setupIntentId: 'not-an-intent' },
  ])('requires a valid sellerDid and SetupIntent reference %j', async (ref) => {
    expect((await POST(request([ref]))).status).toBe(400);
    expect(h.keys).not.toHaveBeenCalled();
  });
  it('validates all references before spending any key', async () => {
    expect((await POST(request([REF, REF]))).status).toBe(400); expect(h.keys).not.toHaveBeenCalled();
  });
  it('preflights the whole batch before charging any seller', async () => {
    seed('seti_two', { ...BINDING, pledgeId: 'pledge2', sellerDid: OTHER });
    expect((await POST(request([REF, { ...REF, pledgeId: 'pledge2', setupIntentId: 'seti_two' }]))).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });
  it('never reads environment Stripe keys with present or missing sealed credentials', async () => {
    const env = new Proxy(process.env, { get(target, field) {
      if (field === 'STRIPE_SECRET_KEY' || field === 'STRIPE_PUBLISHABLE_KEY') throw new Error('Forbidden node credential read');
      return Reflect.get(target, field);
    } });
    vi.stubGlobal('process', { ...process, env });
    expect((await POST(request())).status).toBe(200);
    h.keys.mockRejectedValue(new SellerNoCardRailError());
    const missing = await POST(request());
    expect(missing.status).toBe(400); expect(await missing.json()).toMatchObject({ code: 'SELLER_NO_CARD_RAIL' });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('fails safely on an unavailable seller account without leaking upstream errors', async () => {
    h.retrieve.mockRejectedValue(new Error('credential-bearing upstream error'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('credential-bearing');
  });
  it('returns a clear 404 for a setup absent from the selected seller account', async () => {
    h.retrieve.mockRejectedValue({ statusCode: 404, message: 'unsafe upstream message' });
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'PLEDGE_SETUP_NOT_FOUND' });
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe('Stripe-side replay and race protection', () => {
  it.each(['succeeded', 'processing', 'requires_action'])('never recharges a %s attempt, including after retention expires', async (status) => {
    h.create.mockResolvedValue({ id: 'pi_one', status });
    expect((await POST(request())).status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7 * 86_400_000);
    const retry = await POST(request());
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: 'PLEDGE_CHARGE_ALREADY_ATTEMPTED' });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('blocks retries after an ambiguous charge response', async () => {
    h.create.mockRejectedValue(new Error('lost response'));
    expect(await (await POST(request())).json()).toMatchObject({ failed: 1 });
    expect((await POST(request())).status).toBe(409); expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('does not issue a charge if writing the permanent attempt marker fails', async () => {
    h.update.mockRejectedValue(new Error('write unavailable'));
    expect(await (await POST(request())).json()).toMatchObject({ failed: 1 });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('blocks an expired in-flight claim before the charge request', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    h.update.mockImplementation(async () => { clock.mockReturnValue(now + 60_000); });
    expect((await POST(request())).status).toBe(409); expect(h.create).not.toHaveBeenCalled();
  });
  it('does not charge a stale preflight after another request claimed it', async () => {
    const [pledge] = await loadAppPledges(h.app, 'event1', [REF]);
    expect((await POST(request())).status).toBe(200);
    await expect(chargeBoundPledge(pledge, 'event1')).rejects.toMatchObject({ status: 409 });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('refuses changed binding between preflight and charge', async () => {
    const [pledge] = await loadAppPledges(h.app, 'event1', [REF]);
    mutateMetadata({ sellerDid: OTHER });
    await expect(chargeBoundPledge(pledge, 'event1')).rejects.toMatchObject({ status: 403 });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('refuses an event mismatch after preflight', async () => {
    const [pledge] = await loadAppPledges(h.app, 'event1', [REF]);
    await expect(chargeBoundPledge(pledge, 'other')).rejects.toMatchObject({ status: 403 });
  });
  it('concurrent requests use the identical Stripe idempotency key and cannot create two payments', async () => {
    const [pledge] = await loadAppPledges(h.app, 'event1', [REF]);
    await Promise.allSettled([chargeBoundPledge(pledge, 'event1'), chargeBoundPledge(pledge, 'event1')]);
    expect(h.payments.size).toBe(1);
    expect(new Set(h.create.mock.calls.map(([, options]) => options.idempotencyKey)).size).toBe(1);
    expect(h.create.mock.calls.every(([input]) => input.amount === 1000 && input.customer === 'cus_buyer')).toBe(true);
  });
});

describe('route boundary', () => {
  it('still requires app-service authentication', async () => {
    const req = request(); req.headers.delete('authorization');
    expect((await POST(req)).status).toBe(401); expect(h.keys).not.toHaveBeenCalled();
  });
  it('still rate limits off-session charging', async () => {
    h.limited = true;
    expect((await POST(request())).status).toBe(429); expect(h.keys).not.toHaveBeenCalled();
  });
  it('rejects malformed batches and event ids', async () => {
    expect((await POST(request([], { eventId: '' }))).status).toBe(400);
    expect((await POST(request([], { pledges: null }))).status).toBe(400);
    expect((await POST(request([]))).status).toBe(200);
  });
  it('maps unsafe exceptions to a generic unavailable response', () => {
    expect(pledgeFailure(new Error('unsafe upstream text'))).toMatchObject({ status: 503, code: 'PLEDGE_CHARGE_UNAVAILABLE' });
  });
  it.each(['null', 'false', '"bad"', '{invalid'])('returns 400 for malformed body %s', async (body) => {
    const req = new NextRequest('https://kernel.test/pay/api/charge-pledges', {
      method: 'POST', headers: { authorization: 'Bearer fake-app-token', 'content-type': 'application/json' }, body,
    });
    expect((await POST(req)).status).toBe(400);
    expect(h.keys).not.toHaveBeenCalled();
  });
});
