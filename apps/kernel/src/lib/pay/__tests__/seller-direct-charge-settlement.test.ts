import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { transactions } from '@/src/db/schemas/pay';
import { createPgliteLedgerHarness, type PgliteLedgerConnection, type PgliteLedgerHarness } from './pglite-pay-harness';

const h = vi.hoisted(() => ({
  db: undefined as unknown as PgliteLedgerConnection,
  create: vi.fn(), customer: vi.fn(), notify: vi.fn(), log: vi.fn(), appAuth: vi.fn(),
}));
vi.mock('@/src/db', async () => {
  const schema = await import('@/src/db/schemas/pay');
  return {
    ...schema,
    db: new Proxy({}, { get: (_target, key) => {
      const value = Reflect.get(h.db, key);
      return typeof value === 'function' ? value.bind(h.db) : value;
    } }),
  };
});
vi.mock('stripe', () => ({ default: class { paymentIntents = { create: h.create }; } }));
vi.mock('@/src/lib/pay/rails/stripe-keys', () => ({
  resolveDidStripeKeys: async () => ({ secretKey: 'sk_test_obvious_fake', publishableKey: 'pk_test_obvious_fake' }),
  SellerNoCardRailError: class extends Error {},
}));
vi.mock('@imajin/logger', () => ({
  withLogger: (_name: string, handler: Function) => (request: Request) => handler(request, { log: { error: h.log } }),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.log }),
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: async () => ({ error: 'Anonymous', status: 401 }),
  requireAppAuth: h.appAuth, resolveActingDid: vi.fn(),
}));
vi.mock('@imajin/auth/delegation-policy', () => ({ enforceRoutePolicy: vi.fn() }));
vi.mock('@imajin/config', () => ({ rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1' }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@/src/lib/pay/providers/crypto-only', () => ({ getCryptoOnlyProvider: vi.fn() }));
vi.mock('@/src/lib/stripe/byo-checkout', () => ({ retrieveByoCheckoutCustomer: h.customer }));
vi.mock('@imajin/bus', () => ({ registerReactor: vi.fn(), publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/pay/stripe-relay-store', () => ({ getRelayEntry: vi.fn() }));
vi.mock('@/src/lib/pay/node-topup-settlement', () => ({ settleNodeTopupFromStripe: async () => false }));
vi.mock('@/src/lib/pay/payment-requests/byo-settlement', () => ({ settlePaymentRequestFromByoStripe: vi.fn() }));
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({ settlePaymentRequestFromStripeCheckout: vi.fn() }));
vi.mock('@/src/lib/pay/providers/stripe-webhook', () => ({ toRailEvent: vi.fn() }));
vi.mock('@/src/lib/pay/withdraw-intent', () => ({ confirmWithdrawalFromRailEvent: vi.fn() }));
vi.mock('@/src/lib/pay/rails/registry', () => ({ getWithdrawRailByName: vi.fn() }));
vi.mock('@/src/lib/pay/providers/stripe-withdraw-rail', () => ({ stripeRailName: 'stripe' }));
vi.mock('@/src/lib/pay/webhook-handlers', () => ({ notifyCheckoutServices: h.notify }));

import { POST } from '../../../../app/pay/api/charge/route';
import { payStripeReactor } from '../stripe-bus-consumer';
import { persistSellerCharge } from '../providers/seller-transactions';
import { checkRefundEligibility, resolveOriginalTransaction } from '../refund';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let harness: PgliteLedgerHarness;
const SELLER = 'did:test:seller';
const INTENT = { id: 'pi_obvious_fake', amount: 123, currency: 'cad', created: 1, status: 'requires_confirmation',
  client_secret: 'fake-client-secret' };
const request = (overrides = {}, app = false) => new NextRequest('https://kernel.test/pay/api/charge', {
  headers: app ? { 'x-app-did': 'did:test:app' } : {},
  method: 'POST', body: JSON.stringify({ amount: 123, currency: 'CAD', to: { did: SELLER },
    metadata: { service: 'coffee', appDid: 'did:test:spoof', payTransactionId: 'spoof', settledPaymentIntentId: 'pi_spoof' }, ...overrides }),
});
async function receipt(transactionId: string) {
  await payStripeReactor({ type: 'stripe.payment_intent.succeeded', issuer: SELLER, subject: SELLER, scope: 'stripe',
    payload: { ownerDid: SELLER, payTransactionId: transactionId, paymentIntentId: INTENT.id, amount: 123, currency: 'CAD' } }, {});
}
beforeAll(async () => {
  harness = await createPgliteLedgerHarness();
  // The shared balance harness predates transaction provenance in migration 0170.
  const migration = readFileSync(new URL('../../../../../../migrations/archive/pre-kernel-baseline/0170_emission_config.sql', import.meta.url), 'utf8');
  const transactionAlter = migration.match(/ALTER TABLE pay\.transactions[\s\S]*?;/)?.[0];
  if (!transactionAlter) throw new Error('Transaction provenance migration statement not found');
  await harness.client.exec(transactionAlter);
  h.db = harness.connA;
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await harness.client.exec('DELETE FROM pay.transactions');
  h.create.mockImplementation(async (params) => ({ ...INTENT, metadata: params.metadata }));
  h.appAuth.mockResolvedValue({ appAuth: { userDid: 'did:test:buyer', appDid: 'did:test:verified-app' } });
  await harness.seedBalance({ did: SELLER, unit: 'MJN', amount: 20 });
});

describe('direct seller charge through the real BYO bus handler and PostgreSQL', () => {
  it('preserves hosted checkout settlement and PI refund lookup when its caller uses type=charge', async () => {
    await h.db.insert(transactions).values({
      id: 'tx_hosted', service: 'events', type: 'charge', appDid: 'did:test:verified-app',
      fromDid: 'did:test:buyer', toDid: SELLER, amount: '1.23', currency: 'CAD',
      rail: 'stripe-byo', status: 'pending', externalRef: 'cs_hosted',
    });
    h.customer.mockResolvedValue({ email: null, name: null });
    await receipt('tx_hosted');
    const [completed] = await h.db.select().from(transactions);
    expect(completed).toMatchObject({
      status: 'completed', externalRef: 'cs_hosted', settledAt: expect.any(Date),
      metadata: { settledPaymentIntentId: INTENT.id },
    });
    expect(h.customer).toHaveBeenCalledWith(SELLER, 'cs_hosted');
    expect(h.notify).toHaveBeenCalledTimes(1);
    const original = await resolveOriginalTransaction(INTENT.id, { error: h.log }, 'did:test:verified-app');
    expect(original?.id).toBe('tx_hosted');
    expect(h.log).not.toHaveBeenCalled();
  });
  it('resolves the verified app-owned receipt and permits a refund after the webhook completes it', async () => {
    expect((await POST(request({}, true))).status).toBe(200);
    const [pending] = await h.db.select().from(transactions);
    await receipt(pending.id);
    const original = await resolveOriginalTransaction(INTENT.id, { error: h.log }, 'did:test:verified-app');
    expect(original).toMatchObject({ id: pending.id, appDid: 'did:test:verified-app', status: 'completed', settledAt: expect.any(Date) });
    expect(await checkRefundEligibility(original!, 123)).toMatchObject({ ok: true, requestedRefundDollars: 1.23 });
  });
  it('persists before Stripe and completes the row on its verified receipt without checkout or ledger effects', async () => {
    h.create.mockImplementation(async (params, options) => {
      const [row] = await h.db.select().from(transactions);
      expect(row).toMatchObject({ id: params.metadata.payTransactionId, status: 'pending', type: 'charge',
        rail: 'stripe-byo', externalRef: null, settledAt: null, toDid: SELLER, appDid: null });
      expect(options.idempotencyKey).toBe(`seller-charge:${row.id}`);
      expect(params.metadata.pay_transaction_id).toBe(row.id);
      expect(params.metadata).not.toHaveProperty('settledPaymentIntentId');
      expect(params.metadata).not.toHaveProperty('appDid');
      return { ...INTENT, metadata: params.metadata };
    });
    expect((await POST(request())).status).toBe(200);
    const [pending] = await h.db.select().from(transactions);
    expect(pending.status).toBe('pending');
    await receipt(pending.id);
    const [completed] = await h.db.select().from(transactions);
    expect(completed).toMatchObject({ status: 'completed', settledAt: expect.any(Date), externalRef: INTENT.id,
      metadata: expect.objectContaining({ settledPaymentIntentId: INTENT.id }) });
    const settledAt = completed.settledAt;
    await receipt(pending.id);
    expect((await h.db.select().from(transactions))[0].settledAt).toEqual(settledAt);
    expect(h.customer).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled();
    expect(await harness.readBalance(harness.connA, SELLER, 'MJN')).toBe(20);
    expect(h.log).not.toHaveBeenCalled();
  });
  it('preserves verified app ownership in both row and PI metadata despite caller spoofing', async () => {
    expect((await POST(request({}, true))).status).toBe(200);
    const [row] = await h.db.select().from(transactions);
    expect(row).toMatchObject({ appDid: 'did:test:verified-app', fromDid: 'did:test:buyer',
      metadata: expect.objectContaining({ appDid: 'did:test:verified-app' }) });
    expect(h.create.mock.calls[0][0].metadata.appDid).toBe('did:test:verified-app');
  });
  it('permanently refuses repeated caller keys, including beyond Stripe idempotency retention', async () => {
    const body = { idempotencyKey: 'obvious-fake-caller-dedupe' };
    expect((await POST(request(body))).status).toBe(200);
    const response = await POST(request(body));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SELLER_CHARGE_ALREADY_ATTEMPTED' });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 7 * 86_400_000);
    try { expect((await POST(request(body))).status).toBe(409); }
    finally { clock.mockRestore(); }
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(await h.db.select().from(transactions)).toHaveLength(1);
  });
  it('atomic duplicate claims permit at most one Stripe creation under concurrent caller-key requests', async () => {
    const body = { idempotencyKey: 'obvious-fake-race-key' };
    const responses = await Promise.all([POST(request(body)), POST(request(body))]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(await h.db.select().from(transactions)).toHaveLength(1);
  });
  it('allows webhook completion before the SDK response binds externalRef without resetting settlement', async () => {
    h.create.mockImplementation(async (params) => {
      await receipt(params.metadata.payTransactionId);
      return { ...INTENT, metadata: params.metadata };
    });
    expect((await POST(request())).status).toBe(200);
    const [row] = await h.db.select().from(transactions);
    expect(row).toMatchObject({ status: 'completed', externalRef: INTENT.id, settledAt: expect.any(Date),
      metadata: expect.objectContaining({ settledPaymentIntentId: INTENT.id }) });
    expect(h.customer).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
  });
  it('keeps the durable pending row when Stripe response is lost and settles it from the later receipt', async () => {
    h.create.mockRejectedValue(new Error('fake-lost-response'));
    expect((await POST(request())).status).toBe(500);
    const [row] = await h.db.select().from(transactions);
    expect(row).toMatchObject({ status: 'pending', externalRef: null, settledAt: null });
    await receipt(row.id);
    expect((await h.db.select().from(transactions))[0]).toMatchObject({ status: 'completed', externalRef: INTENT.id,
      settledAt: expect.any(Date), metadata: expect.objectContaining({ settledPaymentIntentId: INTENT.id }) });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('fake-lost-response');
  });
  it('refuses a mismatched existing PaymentIntent binding in both response and webhook updates', async () => {
    await POST(request());
    const [row] = await h.db.select().from(transactions);
    await h.db.update(transactions).set({ externalRef: 'pi_other_fake' }).where(eq(transactions.id, row.id));
    await persistSellerCharge(row.id, { ...INTENT, provider: 'stripe', status: 'pending', currency: 'CAD', createdAt: new Date() });
    await receipt(row.id);
    expect((await h.db.select().from(transactions))[0]).toMatchObject({ status: 'pending', externalRef: 'pi_other_fake', settledAt: null });
    expect(h.notify).not.toHaveBeenCalled();
  });
});
