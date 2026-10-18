/**
 * POST /pay/api/checkout — app-authenticated checkout binding (#2642), against
 * a real embedded Postgres (pglite): a checkout carrying an app-service token
 * records the calling app DID + the payee manifest on `pay.transactions`
 * (settled marker still NULL); seller checkouts without one are refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { createPgliteLedgerHarness, type PgliteLedgerHarness } from '@/src/lib/pay/__tests__/pglite-pay-harness';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
  dbHolder: { db: null as unknown },
  tokens: new Map<string, Record<string, unknown>>(),
  payCheckout: vi.fn(),
  requireAuth: vi.fn(),
  requireAppAuth: vi.fn(),
}));

vi.mock('@/src/db', async () => {
  const pay = await import('@/src/db/schemas/pay');
  const registry = await import('@/src/db/schemas/registry');
  const db = new Proxy({}, {
    get: (_t, prop) => {
      const target = mocks.dbHolder.db as Record<string | symbol, unknown>;
      const value = target[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, ...pay, ...registry };
});
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: async (token: string) => mocks.tokens.get(token) ?? null }));
vi.mock('@/src/lib/pay', () => ({ DEFAULT_PLATFORM_FEE_BPS: 100 }));
vi.mock('@/src/lib/stripe/byo-checkout', () => ({ createByoCheckoutSession: mocks.payCheckout }));
vi.mock('@/src/lib/pay/payment-requests/card-rail', () => ({ resolveCardRail: async (ownerDid: string) => ({ kind: 'connector', ownerDid }), SELLER_NO_CARD_RAIL: 'SELLER_NO_CARD_RAIL' }));
vi.mock('@/src/lib/pay/settle-core', () => ({ settlePayment: vi.fn() }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }) }));
vi.mock('@imajin/config', () => ({ rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1' }));
vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) => (req: unknown) =>
    handler(req, { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth,
  requireAppAuth: mocks.requireAppAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

import { POST } from '../route';
import { transactions } from '@/src/db/schemas/pay';

const APP = 'did:imajin:coffee-app';
const EVENTS_APP = 'did:imajin:registered-events-app';
const OTHER_APP = 'did:imajin:unapproved-app';
const SELLER = 'did:imajin:creator';
const PLATFORM = 'did:imajin:platform';
const USER = 'did:imajin:user';

const PAYEE_MANIFEST = {
  chain: [
    { did: SELLER, role: 'creator', amount: 9.85 },
    { did: PLATFORM, role: 'platform', amount: 0.15 },
  ],
};

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** Looks like a JWT to the cheap header peek; the signature check itself is faked via `mocks.tokens`. */
const jwtLike = (typ: string) => `${b64({ alg: 'EdDSA', typ })}.${b64({})}.sig`;
const SERVICE_TOKEN = jwtLike('app-service+jwt');

let harness: PgliteLedgerHarness;
let db: PgliteDatabase;

function checkoutRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new Request('https://kernel.test/pay/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      items: [{ name: 'Support', amount: 1000, quantity: 1 }],
      currency: 'USD',
      sellerDid: SELLER,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/cancel',
      metadata: { service: 'coffee', type: 'checkout' },
      ...body,
    }),
  }) as unknown as NextRequest;
}

async function rowFor(id: string) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
  return row;
}

beforeAll(async () => {
  harness = await createPgliteLedgerHarness();
  const migrationsDir = join(__dirname, '../../../../../../../migrations');
  await harness.client.exec(readFileSync(join(migrationsDir, '0007_registry_apps.sql'), 'utf-8'));
  await harness.client.exec(readFileSync(join(migrationsDir, '0179_registry_apps_approved_service_scopes.sql'), 'utf-8'));
  await harness.client.exec(`
    ALTER TABLE pay.transactions
      ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
      ADD COLUMN IF NOT EXISTS emission_config_id TEXT,
      ADD COLUMN IF NOT EXISTS emission_config_version INTEGER;`);
  db = drizzle(harness.client);
  mocks.dbHolder.db = db;

  const insertApp = (appDid: string, approved: string[]) =>
    harness.client.query(
      `INSERT INTO registry.apps (id, owner_did, name, app_did, public_key, callback_url, status, approved_service_scopes)
       VALUES ($1, 'did:imajin:owner', $1, $2, 'aa', 'https://app.test/cb', 'active', $3::jsonb)`,
      [`app_${appDid}`, appDid, JSON.stringify(approved)],
    );
  await insertApp(APP, ['pay:settle']);
  await insertApp(EVENTS_APP, ['pay:settle']);
  await insertApp(OTHER_APP, []);
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.tokens.clear();
  mocks.tokens.set(SERVICE_TOKEN, { sub: APP, azp: APP, scope: 'pay:settle', attestationId: '', isServiceToken: true });
  mocks.payCheckout.mockImplementation(async () => ({
    id: `cs_${Math.random().toString(36).slice(2)}`,
    url: 'https://checkout.test/x',
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  }));
  mocks.requireAuth.mockResolvedValue({ error: 'no session', status: 401 });
  await db.delete(transactions);
});

describe('POST /pay/api/checkout — app-authenticated checkout (#2642)', () => {
  it('records the calling app DID and the declared payee manifest; the settled marker stays NULL', async () => {
    const res = await POST(checkoutRequest({ payeeManifest: PAYEE_MANIFEST }, { Authorization: `Bearer ${SERVICE_TOKEN}` }));

    expect(res.status).toBe(200);
    const { transactionId } = await res.json();
    const row = await rowFor(transactionId);
    expect(row).toMatchObject({
      appDid: APP,
      payeeManifest: PAYEE_MANIFEST,
      status: 'pending',
      service: 'coffee',
      settledAt: null,
      settleBatchId: null,
      // The app acts as itself — no user identity is invented for the payer.
      fromDid: null,
    });
  });

  it('falls back to the checkout fairManifest as the payee manifest when none is declared separately', async () => {
    const res = await POST(checkoutRequest({ fairManifest: PAYEE_MANIFEST }, { Authorization: `Bearer ${SERVICE_TOKEN}` }));

    const { transactionId } = await res.json();
    const row = await rowFor(transactionId);
    expect(row.appDid).toBe(APP);
    expect(row.payeeManifest).toEqual(PAYEE_MANIFEST);
  });

  it('records a NULL payee manifest when the app declared none (such a payment can never be settled)', async () => {
    const res = await POST(checkoutRequest({}, { Authorization: `Bearer ${SERVICE_TOKEN}` }));

    const { transactionId } = await res.json();
    const row = await rowFor(transactionId);
    expect(row.appDid).toBe(APP);
    expect(row.payeeManifest).toBeNull();
  });

  it('refuses (403) a service token whose app has no operator-approved pay:settle, and creates nothing', async () => {
    const token = jwtLike('app-service+jwt') + 'x';
    mocks.tokens.set(token, { sub: OTHER_APP, azp: OTHER_APP, scope: 'pay:settle', attestationId: '', isServiceToken: true });

    const res = await POST(checkoutRequest({ payeeManifest: PAYEE_MANIFEST }, { Authorization: `Bearer ${token}` }));

    expect(res.status).toBe(403);
    expect(await db.select().from(transactions)).toHaveLength(0);
    expect(mocks.payCheckout).not.toHaveBeenCalled();
  });

  it('refuses (401) a service-typed token that does not verify', async () => {
    const res = await POST(checkoutRequest({}, { Authorization: `Bearer ${jwtLike('app-service+jwt').replace('.sig', '.forged')}` }));

    expect(res.status).toBe(401);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });
});

describe('POST /pay/api/checkout — seller requires an app service token (#2866)', () => {
  it.each([
    ['anonymous', {}],
    ['session cookie', { Cookie: 'session=fixture' }],
    ['session bearer', { Authorization: 'Bearer session-token' }],
    ['session JWT', { Authorization: `Bearer ${jwtLike('session+jwt')}` }],
    ['delegated app attestation', { 'x-app-did': APP }],
    ['malformed bearer', { Authorization: 'Bearer invalid' }],
  ])('refuses %s without opening a session or recording a payment', async (_label, headers) => {
    mocks.requireAuth.mockResolvedValue({ identity: { id: USER } });
    mocks.requireAppAuth.mockResolvedValue({ appAuth: { appDid: APP, userDid: USER, scopes: ['wallet:write'], attestationId: 'att' } });

    const res = await POST(checkoutRequest({ payeeManifest: PAYEE_MANIFEST }, headers as Record<string, string>));

    expect(res.status).toBe(401);
    expect(mocks.payCheckout).not.toHaveBeenCalled();
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.requireAppAuth).not.toHaveBeenCalled();
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it('also refuses an anonymous seller named only in metadata, before item validation', async () => {
    const res = await POST(checkoutRequest({ sellerDid: undefined, items: [], metadata: { sellerDid: SELLER } }));

    expect(res.status).toBe(401);
    expect(mocks.payCheckout).not.toHaveBeenCalled();
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it('accepts the events app-token checkout and binds metadata-only sellers to the verified app', async () => {
    mocks.tokens.set(SERVICE_TOKEN, { sub: EVENTS_APP, azp: EVENTS_APP, scope: 'pay:settle', attestationId: '', isServiceToken: true });
    const res = await POST(checkoutRequest({
      sellerDid: undefined,
      metadata: { service: 'events', eventId: 'evt_1', sellerDid: SELLER, appDid: OTHER_APP },
    }, { Authorization: `Bearer ${SERVICE_TOKEN}` }));

    expect(res.status).toBe(200);
    expect(await rowFor((await res.json()).transactionId)).toMatchObject({ appDid: EVENTS_APP, toDid: SELLER, service: 'events' });
    expect(mocks.payCheckout).toHaveBeenCalledTimes(1);
  });

  it('does not add an app-token requirement when no seller is named (card checkout still refuses)', async () => {
    const res = await POST(checkoutRequest({ sellerDid: undefined }));

    expect(res.status).toBe(400);
    expect(mocks.requireAuth).toHaveBeenCalled();
    expect(mocks.payCheckout).not.toHaveBeenCalled();
  });
});
