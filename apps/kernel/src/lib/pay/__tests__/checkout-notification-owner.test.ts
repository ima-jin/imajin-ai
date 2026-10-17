import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { createPgliteLedgerHarness, type PgliteLedgerHarness } from './pglite-pay-harness';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  post: vi.fn(),
  publish: vi.fn().mockResolvedValue(undefined),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  settledSession: null as unknown,
}));
vi.mock('@/src/db', async () => {
  const pay = await import('@/src/db/schemas/pay');
  const registry = await import('@/src/db/schemas/registry');
  return {
    ...pay, ...registry,
    db: new Proxy({}, {
      get: (_target, prop) => {
        const target = mocks.db as Record<string | symbol, unknown>;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});
vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish, registerReactor: vi.fn() }));
vi.mock('../settle-core', () => ({ verifySettlementSignature: vi.fn() }));
vi.mock('../providers/stripe-webhook', () => ({ fetchActualFee: vi.fn() }));
vi.mock('@/src/lib/auth/kernel-webhook', () => ({
  kernelWebhookUrl: (url: string, path: string) => `${url}${path}`,
  postKernelWebhook: mocks.post,
}));

import { notifyCheckoutServices } from '../webhook-handlers';
import { payStripeReactor } from '../stripe-bus-consumer';
import type { StripeCheckoutSessionLike } from '../webhook-event-shapes';

vi.mock('../byo-checkout-settlement', () => ({
  settleCheckoutFromByoStripe: async () => ({ settled: true, session: mocks.settledSession }),
}));
vi.mock('../node-topup-settlement', () => ({ settleNodeTopupFromStripe: async () => false }));
vi.mock('../payment-requests/byo-settlement', () => ({ settlePaymentRequestFromByoStripe: vi.fn() }));
vi.mock('../payment-requests/checkout', () => ({ settlePaymentRequestFromStripeCheckout: vi.fn() }));
vi.mock('../withdraw-intent', () => ({ confirmWithdrawalFromRailEvent: vi.fn() }));
vi.mock('../rails/registry', () => ({ getWithdrawRailByName: vi.fn() }));
vi.mock('../providers/stripe-withdraw-rail', () => ({ stripeRailName: 'stripe' }));

let harness: PgliteLedgerHarness;
let db: PgliteDatabase;
const APPS = ['events', 'market', 'learn', 'coffee'] as const;
// Deliberately not did:imajin:<slug>: registration, not a DID naming convention, is authoritative.
const didFor = (slug: string) => `did:imajin:registered-${slug}-123`;
const session = (overrides: Partial<StripeCheckoutSessionLike> = {}): StripeCheckoutSessionLike => ({
  id: 'cs_owned', rail: 'stripe-byo', transactionId: 'tx_owned',
  amount_total: 5000, currency: 'cad', sellerDid: 'did:imajin:seller',
  metadata: {
    eventId: 'evt_target', service: 'market', source: 'learn',
    sellerDid: 'did:imajin:seller', buyerDid: 'did:imajin:buyer',
    appDid: didFor('events'),
  },
  ...overrides,
});

async function seedRow(appDid: string | null, rail = 'stripe-byo') {
  await harness.client.query(
    `INSERT INTO pay.transactions (id, service, type, to_did, amount, currency, status, rail, external_ref, app_did)
     VALUES ('tx_owned', 'checkout', 'checkout', 'did:imajin:seller', '50', 'CAD', 'completed', $1, 'cs_owned', $2)`,
    [rail, appDid],
  );
}

beforeAll(async () => {
  harness = await createPgliteLedgerHarness();
  await harness.client.exec(readFileSync(join(__dirname, '../../../../../../migrations/0007_registry_apps.sql'), 'utf8'));
  await harness.client.exec('ALTER TABLE registry.apps ADD COLUMN IF NOT EXISTS slug TEXT');
  db = drizzle(harness.client);
  mocks.db = db;
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.db = db;
  mocks.post.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubEnv('EVENTS_SERVICE_URL', 'https://events.test');
  vi.stubEnv('MARKET_SERVICE_URL', 'https://market.test');
  vi.stubEnv('LEARN_SERVICE_URL', 'https://learn.test');
  vi.stubEnv('COFFEE_SERVICE_URL', 'https://coffee.test');
  await harness.client.exec('DELETE FROM pay.transactions; DELETE FROM registry.apps');
  for (const slug of APPS) {
    await harness.client.query(
      `INSERT INTO registry.apps (id, owner_did, name, app_did, public_key, callback_url, slug)
       VALUES ($1, 'did:imajin:owner', $1, $2, 'fixture', 'https://app.test/cb', $1)`,
      [slug, didFor(slug)],
    );
  }
});

describe('recorded app ownership gates paid checkout notifications (#2866)', () => {
  it.each(APPS)('only notifies %s for its row despite metadata targeting every app', async (slug) => {
    await seedRow(didFor(slug));
    await notifyCheckoutServices(session());

    expect(mocks.post.mock.calls.map((call) => call[2])).toEqual(slug === 'coffee' ? [] : [slug]);
    expect(mocks.publish.mock.calls.map((call) => call[0])).toEqual(
      slug === 'market' ? ['market.sale', 'market.purchase'] : [],
    );
  });

  it('uses the platform rail and session reference when no transactionId is present', async () => {
    await seedRow(didFor('events'), 'stripe');
    await notifyCheckoutServices(session({ rail: undefined, transactionId: undefined }));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      'https://events.test/api/webhook/payment',
      expect.objectContaining({ transactionId: 'tx_owned' }), 'events',
    );
  });

  it.each([
    ['unbound legacy row', null],
    ['unregistered app', 'did:imajin:missing'],
    ['DID that only looks like the events slug', 'did:imajin:events'],
  ])('does not notify for %s', async (_label, appDid) => {
    await seedRow(appDid);
    await notifyCheckoutServices(session());
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('does not notify a revoked app', async () => {
    await seedRow(didFor('events'));
    await harness.client.exec("UPDATE registry.apps SET status = 'revoked' WHERE slug = 'events'");
    await notifyCheckoutServices(session());
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'cs_other' }, { transactionId: 'tx_other' }, { rail: 'stripe' },
  ])('cannot borrow ownership from a different session, transaction or rail: %j', async (override) => {
    await seedRow(didFor('events'));
    await notifyCheckoutServices(session(override));
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('fails closed without a payment row', async () => {
    await notifyCheckoutServices(session());
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each(['events', 'coffee'])('the BYO reactor gates the separate coffee callback for a %s-owned row', async (slug) => {
    await seedRow(didFor(slug));
    mocks.settledSession = session({ metadata: { service: 'coffee', tipId: 'tip_target' } });
    await payStripeReactor({
      type: 'stripe.payment_intent.succeeded', issuer: 'did:imajin:seller',
      subject: 'did:imajin:seller', scope: 'stripe',
      payload: {
        ownerDid: 'did:imajin:seller', payTransactionId: 'tx_owned',
        paymentIntentId: 'pi_owned', amount: 5000, currency: 'CAD',
      },
    }, {});
    expect(mocks.post.mock.calls.map((call) => call[2])).toEqual(slug === 'coffee' ? ['coffee'] : []);
  });

  it('logs lookup errors and suppresses fulfillment without throwing', async () => {
    mocks.db = { select: () => { throw new Error('database unavailable'); } };
    await expect(notifyCheckoutServices(session())).resolves.toBeUndefined();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'cs_owned' }), expect.stringContaining('notifications suppressed'),
    );
  });
});

afterAll(() => { vi.unstubAllEnvs(); });
