import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPgliteLedgerHarness, type PgliteLedgerHarness } from './pglite-pay-harness';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => ({
  db: null as unknown,
  tokens: new Map<string, Record<string, unknown>>(),
  create: vi.fn(),
  retrieve: vi.fn(),
  refund: vi.fn(),
  setup: vi.fn(),
  ledger: vi.fn(),
  keys: vi.fn(),
  customer: vi.fn(),
  method: vi.fn(),
}));
vi.mock('@/src/db', async () => {
  const pay = await import('@/src/db/schemas/pay');
  const registry = await import('@/src/db/schemas/registry');
  const db = new Proxy({}, { get: (_target, prop) => {
    const target = h.db as Record<string | symbol, unknown>;
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db, ...pay, ...registry };
});
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: async (token: string) => h.tokens.get(token) ?? null }));
vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('./mock-drizzle-table');
  return { withLogger: withLoggerPassthrough(), createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) };
});
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }) }));
vi.mock('@imajin/config', async (original) => ({
  ...await original<object>(), rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1',
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: () => ({ refund: h.refund }) }));
vi.mock('@/src/lib/pay/rails/stripe-keys', () => ({
  resolveDidStripeKeys: h.keys,
  SellerNoCardRailError: class extends Error { code = 'SELLER_NO_CARD_RAIL'; },
}));
vi.mock('@/src/lib/pay/providers/seller-pledge-refund', () => ({
  sellerPledgeRefundClient: () => ({
    paymentIntents: { create: h.create },
    refunds: { create: h.refund },
    setupIntents: { retrieve: h.retrieve, create: h.setup },
    customers: { retrieve: h.customer },
    paymentMethods: { retrieve: h.method },
  }),
  findOrCreatePledgeCustomer: async () => ({ id: 'cus_recorded' }),
  sellerSessionPaymentIntent: async () => 'pi_payment',
}));
vi.mock('@/src/lib/pay/refund', async (original) => ({
  ...await original<object>(),
  applyRefundLedgerUpdates: h.ledger,
  reverseSettlementEntries: vi.fn().mockResolvedValue(undefined),
}));

import { POST as refundRoute } from '../../../../app/pay/api/refund/route';
import { db, transactions, registryApps } from '@/src/db';
import { eq } from 'drizzle-orm';

let harness: PgliteLedgerHarness;
const APP = 'did:imajin:app-a';
const OTHER = 'did:imajin:app-b';
const SCOPES = ['pay:refund', 'pay:charge-pledges'];
function request(path: string, body: unknown, token = 'service', cookie = '') {
  return new Request(`https://kernel.test/pay/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  }) as never;
}
async function payment(appDid: string | null = APP, type = 'checkout') {
  await db.insert(transactions).values({
    id: 'tx_payment', service: 'events', type, appDid, toDid: 'did:imajin:seller', fromDid: 'did:imajin:backer',
    amount: '10', currency: 'CAD', rail: 'stripe-byo',
    externalRef: type === 'pledge' ? 'seti_1' : 'cs_payment',
    status: type === 'pledge' ? 'pending' : 'completed',
    idempotencyKey: type === 'pledge' ? 'pledge-setup:seti_1' : null,
    metadata: { eventId: 'evt', stripeCustomerId: 'cus_recorded' },
  });
}
beforeAll(async () => {
  harness = await createPgliteLedgerHarness();
  const dir = join(__dirname, '../../../../../../migrations/archive/pre-kernel-baseline');
  await harness.client.exec(readFileSync(join(dir, '0007_registry_apps.sql'), 'utf8'));
  await harness.client.exec(readFileSync(join(dir, '0179_registry_apps_approved_service_scopes.sql'), 'utf8'));
  await harness.client.exec(`ALTER TABLE pay.transactions ADD COLUMN idempotency_key TEXT,
    ADD COLUMN emission_config_id TEXT, ADD COLUMN emission_config_version INTEGER;`);
  h.db = drizzle(harness.client);
  for (const appDid of [APP, OTHER]) {
    await harness.client.query(
      `INSERT INTO registry.apps (id, app_did, owner_did, name, public_key, callback_url, status, approved_service_scopes)
       VALUES ($1, $1, 'did:imajin:owner', $1, 'aa', 'https://app.test', 'active', $2::jsonb)`,
      [appDid, JSON.stringify(SCOPES)],
    );
  }
});
afterAll(async () => { await harness?.close(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.clearAllMocks();
  h.tokens.clear();
  h.tokens.set('service', { azp: APP, scope: SCOPES.join(' '), isServiceToken: true });
  h.tokens.set('wrong-scope', { azp: APP, scope: 'pay:settle', isServiceToken: true });
  h.tokens.set('no-scope', { azp: APP, scope: '', isServiceToken: true });
  h.tokens.set('delegated', { azp: APP, scope: SCOPES.join(' '), isServiceToken: false });
  h.refund.mockResolvedValue({ id: 're_1', paymentId: 'cs_payment', amount: 1000, status: 'succeeded' });
  h.keys.mockResolvedValue({ secretKey: 'test-only-seller-key', publishableKey: 'test-only-publishable-key' });
  h.customer.mockResolvedValue({ metadata: { did: 'did:imajin:backer' } });
  h.method.mockResolvedValue({ customer: 'cus_recorded' });
  h.ledger.mockResolvedValue({ reversalId: 'tx_refund', isFullRefund: true });
  h.retrieve.mockResolvedValue({ status: 'succeeded', customer: 'cus_recorded', payment_method: 'pm_recorded',
    metadata: { app_did: APP, sellerDid: 'did:imajin:seller', did: 'did:imajin:backer', eventId: 'evt', amount: '1000', currency: 'CAD' } });
  h.create.mockResolvedValue({ id: 'pi_1', status: 'succeeded' });
  h.setup.mockResolvedValue({ id: 'seti_new', client_secret: 'test-only' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ did: 'did:imajin:backer' }))));
  await db.delete(transactions);
  await db.update(registryApps).set({ status: 'active', approvedServiceScopes: SCOPES });
});

describe.each([
  ['refund', refundRoute, () => ({ paymentId: 'cs_payment' }), 'checkout', 'pay:refund'],
] as const)('%s app authority', (path, route, body, type, scope) => {
  it('rejects the retired shared key with no money movement', async () => {
    process.env.PAY_SERVICE_API_KEY = 'retired-shared-key';
    expect((await route(request(path, body(), 'retired-shared-key'))).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.refund).not.toHaveBeenCalled();
  });
  it.each(['wrong-scope', 'no-scope', 'delegated'])('rejects %s with 403', async (token) => {
    expect((await route(request(path, body(), token))).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.refund).not.toHaveBeenCalled();
  });
  it('rechecks operator approval on every call', async () => {
    await db.update(registryApps).set({ approvedServiceScopes: [] }).where(eq(registryApps.appDid, APP));
    const response = await route(request(path, body()));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain(scope);
  });
  it('rejects revoked apps', async () => {
    await db.update(registryApps).set({ status: 'revoked' }).where(eq(registryApps.appDid, APP));
    expect((await route(request(path, body()))).status).toBe(403);
  });
  it.each([OTHER, null])('refuses payment belonging to %s before side effects', async (appDid) => {
    await payment(appDid, type);
    expect((await route(request(path, body()))).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.refund).not.toHaveBeenCalled();
    expect(h.retrieve).not.toHaveBeenCalled();
  });
  it('allows the owning app with the approved scope', async () => {
    await payment(APP, type);
    expect((await route(request(path, body()))).status).toBe(200);
  });
});
