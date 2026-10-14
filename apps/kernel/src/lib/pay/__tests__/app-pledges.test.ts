import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { setupIntentMetadata } from '../setup-intent';

const h = vi.hoisted(() => ({
  keys: vi.fn(), client: vi.fn(), retrieve: vi.fn(), update: vi.fn(), create: vi.fn(), log: vi.fn(),
  setups: new Map<string, Record<string, unknown>>(),
  payments: new Map<string, { id: string; status: string }>(),
  app: 'did:imajin:events', limited: false, verifiedCustomer: 'did:imajin:buyer',
  attachedCustomer: 'cus_buyer', authDenied: false,
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
  authenticatePayApp: async (request: Request) => !request.headers.has('authorization')
    ? { error: 'App-service token required', status: 401 }
    : h.authDenied ? { error: 'Approved scope required', status: 403 } : { appDid: h.app },
}));
vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: h.limited, retryAfter: 10 }), getClientIP: () => '127.0.0.1',
}));
vi.mock('@imajin/logger', () => ({
  withLogger: (_name: string, handler: (request: NextRequest, context: unknown) => unknown) =>
    (request: NextRequest) => handler(request, { log: { error: h.log } }),
}));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null) }));

import { POST } from '../../../../app/pay/api/charge-pledges/route';
import { chargeBoundPledge, loadAppPledges, pledgeFailure, PledgeChargeError, type BoundPledge } from '../app-pledges';
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
async function expectFailed(response: Response, code?: string) {
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ charged: 0, failed: 1, total: 1,
    results: [{ pledgeId: REF.pledgeId, status: 'failed', ...(code ? { code } : {}) }] });
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
  h.setups.clear(); h.payments.clear(); h.app = 'did:imajin:events'; h.limited = false; h.authDenied = false;
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
  it.each(['sellerDid', 'pledgeId', 'eventId', 'appDid'])('rejects a mismatched %s binding per pledge', async (field) => {
    mutateMetadata({ [field]: 'did:imajin:mismatch' });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ status: 'failed', code: 'PLEDGE_BINDING_MISMATCH' }] });
    expect(h.create).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });
  it('uses the requested seller account but refuses a different seller in its metadata', async () => {
    const response = await POST(request([{ ...REF, sellerDid: OTHER }]));
    expect(response.status).toBe(200); expect(h.keys).toHaveBeenCalledWith(OTHER);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('reports seller rail failure per pledge while continuing to a valid seller', async () => {
    seed('seti_two', { ...BINDING, pledgeId: 'pledge2', sellerDid: OTHER });
    h.keys.mockImplementation(async (did: string) => {
      if (did === SELLER) throw new SellerNoCardRailError();
      return { secretKey: 'rk_test_fake', publishableKey: 'pk_test_fake' };
    });
    const response = await POST(request([REF, { pledgeId: 'pledge2', setupIntentId: 'seti_two', sellerDid: OTHER }]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ charged: 1, failed: 1, total: 2, results: [
      { pledgeId: 'pledge1', status: 'failed', code: 'SELLER_NO_CARD_RAIL' },
      { pledgeId: 'pledge2', status: 'charged' },
    ] });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it.each(['sellerDid', 'pledgeId', 'eventId', 'appDid', 'buyerDid', 'amount', 'currency'])(
    'rejects missing %s binding per pledge', async (field) => {
      mutateMetadata({ [field]: undefined });
      await expectFailed(await POST(request()));
      expect(h.create).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    },
  );
  it.each([null, {}])('rejects missing metadata %j per pledge', async (metadata) => {
    h.setups.get('seti_one')!.metadata = metadata;
    await expectFailed(await POST(request())); expect(h.create).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', 'NaN', '1.2'])('rejects invalid recorded amount %s', async (amount) => {
    mutateMetadata({ amount });
    await expectFailed(await POST(request())); expect(h.create).not.toHaveBeenCalled();
  });
  it('checks buyer/customer attachment using the existing read-only verification', async () => {
    h.verifiedCustomer = OTHER;
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ status: 'failed', code: 'setup_intent_binding_mismatch' }] });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('rejects a payment method attached to the wrong customer', async () => {
    h.attachedCustomer = 'cus_wrong';
    await expectFailed(await POST(request()));
    expect(h.create).not.toHaveBeenCalled();
  });
  it('rejects incomplete setups per pledge', async () => {
    h.setups.get('seti_one')!.status = 'requires_payment_method';
    await expectFailed(await POST(request())); expect(h.create).not.toHaveBeenCalled();
  });
  it('rejects missing customer before verification or charging', async () => {
    h.setups.get('seti_one')!.customer = null;
    await expectFailed(await POST(request())); expect(h.create).not.toHaveBeenCalled();
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
    expect((await POST(request([REF, { ...REF, pledgeId: 'other', setupIntentId: 'invalid' }]))).status).toBe(400);
    expect(h.keys).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });
  it('preflights the whole batch, charges valid bindings and reports invalid ones on replay', async () => {
    seed('seti_two', { ...BINDING, pledgeId: 'pledge2', sellerDid: OTHER });
    const refs = [REF, { ...REF, pledgeId: 'pledge2', setupIntentId: 'seti_two' }];
    const response = await POST(request(refs));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ charged: 1, failed: 1, total: 2, results: [
      { pledgeId: 'pledge1', status: 'charged' },
      { pledgeId: 'pledge2', status: 'failed', code: 'PLEDGE_BINDING_MISMATCH' },
    ] });
    expect(h.retrieve.mock.invocationCallOrder[1]).toBeLessThan(h.create.mock.invocationCallOrder[0]);
    const replay = await POST(request(refs));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ charged: 0, failed: 2, total: 2, results: [
      { pledgeId: 'pledge1', status: 'failed', code: 'PLEDGE_CHARGE_ALREADY_ATTEMPTED' },
      { pledgeId: 'pledge2', status: 'failed', code: 'PLEDGE_BINDING_MISMATCH' },
    ] });
    expect(h.create).toHaveBeenCalledTimes(1); expect(h.update).toHaveBeenCalledTimes(1);
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
    await expectFailed(missing, 'SELLER_NO_CARD_RAIL');
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('fails safely on an unavailable seller account without leaking upstream errors', async () => {
    h.retrieve.mockRejectedValue(new Error('credential-bearing upstream error'));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('credential-bearing');
  });
  it('returns a safe per-pledge not-found code for a setup absent from the selected seller account', async () => {
    h.retrieve.mockRejectedValue({ statusCode: 404, message: 'unsafe upstream message' });
    const response = await POST(request());
    await expectFailed(response, 'PLEDGE_SETUP_NOT_FOUND');
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe('Stripe-side replay and race protection', () => {
  it('retains all three outcomes after pledge #2 fails 4xx mid-charge and never charges on replay', async () => {
    seed('seti_two', { ...BINDING, pledgeId: 'pledge2' });
    seed('seti_three', { ...BINDING, pledgeId: 'pledge3' });
    const refs = [REF,
      { ...REF, pledgeId: 'pledge2', setupIntentId: 'seti_two' },
      { ...REF, pledgeId: 'pledge3', setupIntentId: 'seti_three' }];
    h.create.mockImplementation(async (input: { metadata: { pledgeId: string } }, options: { idempotencyKey: string }) => {
      if (input.metadata.pledgeId === 'pledge2') {
        throw new PledgeChargeError(403, 'PLEDGE_BINDING_MISMATCH', 'Pledge binding changed');
      }
      const payment = { id: `pi_${input.metadata.pledgeId}`, status: 'succeeded' };
      h.payments.set(options.idempotencyKey, payment);
      return payment;
    });
    const response = await POST(request(refs));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ charged: 2, failed: 1, total: 3, results: [
      { pledgeId: 'pledge1', status: 'charged' },
      { pledgeId: 'pledge2', status: 'failed', code: 'PLEDGE_BINDING_MISMATCH', error: 'Pledge binding changed' },
      { pledgeId: 'pledge3', status: 'charged' },
    ] });
    expect(h.retrieve.mock.invocationCallOrder[2]).toBeLessThan(h.create.mock.invocationCallOrder[0]);
    expect(h.create).toHaveBeenCalledTimes(3);
    expect(h.payments.size).toBe(2);
    const markers = refs.map((ref) => (h.setups.get(ref.setupIntentId)!.metadata as Record<string, string>).imajin_pledge_charge_attempt);
    expect(markers.every((marker) => /^[a-f0-9]{64}$/.test(marker))).toBe(true);
    expect(h.create.mock.calls.map(([, options]) => options.idempotencyKey))
      .toEqual(markers.map((marker) => `pledge-charge:${marker}`));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7 * 86_400_000);
    const replay = await POST(request(refs));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ charged: 0, failed: 3, total: 3,
      results: refs.map((ref) => ({ pledgeId: ref.pledgeId, status: 'failed', code: 'PLEDGE_CHARGE_ALREADY_ATTEMPTED' })) });
    expect(h.create).toHaveBeenCalledTimes(3);
    expect(h.update).toHaveBeenCalledTimes(3);
    expect(h.payments.size).toBe(2);
    expect(refs.map((ref) => (h.setups.get(ref.setupIntentId)!.metadata as Record<string, string>).imajin_pledge_charge_attempt))
      .toEqual(markers);
  });
  it.each(['succeeded', 'processing', 'requires_action'])('never recharges a %s attempt, including after retention expires', async (status) => {
    h.create.mockResolvedValue({ id: 'pi_one', status });
    expect((await POST(request())).status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7 * 86_400_000);
    const retry = await POST(request());
    await expectFailed(retry, 'PLEDGE_CHARGE_ALREADY_ATTEMPTED');
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('blocks retries after an ambiguous charge response', async () => {
    h.create.mockRejectedValue(new Error('lost response'));
    expect(await (await POST(request())).json()).toMatchObject({ charged: 0, failed: 1,
      results: [{ status: 'failed', code: 'PLEDGE_CHARGE_UNAVAILABLE' }] });
    expect(h.log).toHaveBeenCalledWith({ pledgeId: REF.pledgeId }, 'Pledge charge failed');
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('lost response');
    await expectFailed(await POST(request())); expect(h.create).toHaveBeenCalledTimes(1);
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
    await expectFailed(await POST(request())); expect(h.create).not.toHaveBeenCalled();
  });
  it('does not charge a stale preflight after another request claimed it', async () => {
    const [outcome] = await loadAppPledges(h.app, 'event1', [REF]);
    expect(outcome).toHaveProperty('pledge');
    const pledge = (outcome as { pledge: BoundPledge }).pledge;
    expect((await POST(request())).status).toBe(200);
    await expect(chargeBoundPledge(pledge, 'event1')).rejects.toMatchObject({ status: 409 });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('refuses changed binding between preflight and charge', async () => {
    const [outcome] = await loadAppPledges(h.app, 'event1', [REF]);
    expect(outcome).toHaveProperty('pledge');
    const pledge = (outcome as { pledge: BoundPledge }).pledge;
    mutateMetadata({ sellerDid: OTHER });
    await expect(chargeBoundPledge(pledge, 'event1')).rejects.toMatchObject({ status: 403 });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('refuses an event mismatch after preflight', async () => {
    const [outcome] = await loadAppPledges(h.app, 'event1', [REF]);
    expect(outcome).toHaveProperty('pledge');
    const pledge = (outcome as { pledge: BoundPledge }).pledge;
    await expect(chargeBoundPledge(pledge, 'other')).rejects.toMatchObject({ status: 403 });
  });
  it('concurrent requests use the identical Stripe idempotency key and cannot create two payments', async () => {
    const [outcome] = await loadAppPledges(h.app, 'event1', [REF]);
    expect(outcome).toHaveProperty('pledge');
    const pledge = (outcome as { pledge: BoundPledge }).pledge;
    await Promise.allSettled([chargeBoundPledge(pledge, 'event1'), chargeBoundPledge(pledge, 'event1')]);
    expect(h.payments.size).toBe(1);
    expect(new Set(h.create.mock.calls.map(([, options]) => options.idempotencyKey)).size).toBe(1);
    expect(h.create.mock.calls.every(([input]) => input.amount === 1000 && input.customer === 'cus_buyer')).toBe(true);
  });
});

describe('route boundary', () => {
  it('still returns HTTP 403 for missing approved scope before preflight', async () => {
    h.authDenied = true;
    expect((await POST(request())).status).toBe(403);
    expect(h.keys).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });
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
