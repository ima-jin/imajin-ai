/**
 * POST /pay/api/settle — the registered-app contract (#2642), end to end
 * against a real embedded Postgres (pglite, via the pay harness): the route,
 * `authenticateSettleApp`, `settleForApp`, `settlePayment` and the real
 * `pay.transactions` / `pay.balances` / `registry.apps` tables. Only the
 * token-signature check (`verifyAppToken`), the bus and the manifest signature
 * primitives are faked — everything that decides WHO may settle WHAT is real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPgliteLedgerHarness, type PgliteLedgerHarness } from '@/src/lib/pay/__tests__/pglite-pay-harness';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
  dbHolder: { db: null as unknown },
  tokens: new Map<string, Record<string, unknown>>(),
  publish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/db', async () => {
  const pay = await import('@/src/db/schemas/pay');
  const registry = await import('@/src/db/schemas/registry');
  // The route modules import `db` once; resolve it lazily so the pglite instance can be created in beforeAll.
  const db = new Proxy({}, {
    get: (_t, prop) => {
      const target = mocks.dbHolder.db as Record<string | symbol, unknown>;
      const value = target[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, ...pay, ...registry, identities: {}, identityChains: {} };
});

vi.mock('@/src/lib/auth/jwt', () => ({
  verifyAppToken: async (token: string) => mocks.tokens.get(token) ?? null,
}));
vi.mock('@imajin/fair', () => ({ verifyManifest: vi.fn().mockResolvedValue({ valid: true }) }));
vi.mock('@imajin/auth/resolve-db', () => ({ createDbResolver: () => async () => null }));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@/src/lib/fair/intro-attribution', () => ({
  verifyIntroAttributionManifestForSettlement: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

import { POST } from '../route';
import { transactions } from '@/src/db/schemas/pay';

type NextRequestLike = Parameters<typeof POST>[0];

const APP_A = 'did:imajin:app-a';
const APP_B = 'did:imajin:app-b';
const APP_NO_APPROVAL = 'did:imajin:app-unapproved';
const APP_REVOKED = 'did:imajin:app-revoked';
const SELLER = 'did:imajin:seller';
const PLATFORM = 'did:imajin:platform';
const TIPPER = 'did:imajin:tipper';

const SHARED_KEY = 'shared-pay-key-for-tests';

let harness: PgliteLedgerHarness;
let db: PgliteDatabase;

function serviceClaims(appDid: string, scope = 'pay:settle') {
  return { sub: appDid, azp: appDid, scope, attestationId: '', isServiceToken: true };
}

function request(body: unknown, token: string | null = 'tok-a', raw?: string): NextRequestLike {
  return new Request('http://localhost:3000/pay/api/settle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  }) as unknown as NextRequestLike;
}

const CHAIN = [
  { did: SELLER, amount: 9.85, role: 'creator' },
  { did: PLATFORM, amount: 0.15, role: 'platform' },
];

const PAYEE_MANIFEST = { chain: CHAIN };

async function insertPayment(row: Partial<typeof transactions.$inferInsert> & { id: string }) {
  await db.insert(transactions).values({
    service: 'coffee',
    type: 'checkout',
    toDid: 'platform',
    amount: '10',
    currency: 'USD',
    status: 'completed',
    rail: 'stripe',
    externalRef: `cs_${row.id}`,
    appDid: APP_A,
    payeeManifest: PAYEE_MANIFEST,
    ...row,
  });
}

async function paymentRow(id: string) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
  return row;
}

async function ledgerRowsForBatch(batchId: string) {
  return db.select().from(transactions).where(eq(transactions.batchId, batchId));
}

async function totalRows() {
  return (await db.select().from(transactions)).length;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  harness = await createPgliteLedgerHarness();
  const migrationsDir = join(__dirname, '../../../../../../../migrations');
  await harness.client.exec(readFileSync(join(migrationsDir, '0007_registry_apps.sql'), 'utf-8'));
  await harness.client.exec(readFileSync(join(migrationsDir, '0179_registry_apps_approved_service_scopes.sql'), 'utf-8'));
  // The drizzle `transactions` table also selects the #2017 emission columns (migration 0170 seeds unrelated kernel tables too, so only its pay DDL is inlined).
  await harness.client.exec(`
    ALTER TABLE pay.transactions
      ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
      ADD COLUMN IF NOT EXISTS emission_config_id TEXT,
      ADD COLUMN IF NOT EXISTS emission_config_version INTEGER;`);
  db = drizzle(harness.client);
  mocks.dbHolder.db = db;

  const insertApp = (appDid: string, status: string, approved: string[]) =>
    harness.client.query(
      `INSERT INTO registry.apps (id, owner_did, name, app_did, public_key, callback_url, status, approved_service_scopes)
       VALUES ($1, 'did:imajin:owner', $1, $2, 'aa', 'https://app.test/cb', $3, $4::jsonb)`,
      [`app_${appDid}`, appDid, status, JSON.stringify(approved)],
    );
  await insertApp(APP_A, 'active', ['pay:settle']);
  await insertApp(APP_B, 'active', ['pay:settle']);
  await insertApp(APP_NO_APPROVAL, 'active', []);
  await insertApp(APP_REVOKED, 'revoked', ['pay:settle']);
});

afterAll(async () => {
  await flush();
  await harness?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.publish.mockResolvedValue(undefined);
  process.env.PAY_SERVICE_API_KEY = SHARED_KEY;
  mocks.tokens.clear();
  mocks.tokens.set('tok-a', serviceClaims(APP_A));
  mocks.tokens.set('tok-b', serviceClaims(APP_B));
  mocks.tokens.set('tok-unapproved', serviceClaims(APP_NO_APPROVAL));
  mocks.tokens.set('tok-revoked', serviceClaims(APP_REVOKED));
  mocks.tokens.set('tok-noscope', serviceClaims(APP_A, 'wallet:read'));
  mocks.tokens.set('tok-user', { sub: 'did:imajin:user', azp: APP_A, scope: 'pay:settle', attestationId: 'att_1', isServiceToken: false });
  await db.delete(transactions);
  await harness.client.exec('DELETE FROM pay.balances');
});

describe('POST /pay/api/settle — authentication (#2642)', () => {
  it('refuses the shared PAY_SERVICE_API_KEY bearer with 401 and settles nothing', async () => {
    await insertPayment({ id: 'tx_key' });

    const res = await POST(request({ transaction_id: 'tx_key', fair_manifest: { chain: CHAIN } }, SHARED_KEY));

    expect(res.status).toBe(401);
    expect((await paymentRow('tx_key')).settledAt).toBeNull();
    expect(await totalRows()).toBe(1);
  });

  it('refuses a request with no credential (401)', async () => {
    const res = await POST(request({ transaction_id: 'tx_x', fair_manifest: { chain: CHAIN } }, null));
    expect(res.status).toBe(401);
  });

  it.each([
    ['a user-delegated app token (not a service token)', 'tok-user'],
    ['a service token without the pay:settle scope', 'tok-noscope'],
    ['a pay:settle token whose app has no operator approval (revoked or never granted)', 'tok-unapproved'],
    ['a token for a revoked app', 'tok-revoked'],
  ])('refuses %s with 403', async (_label, token) => {
    await insertPayment({ id: 'tx_403' });

    const res = await POST(request({ transaction_id: 'tx_403', fair_manifest: { chain: CHAIN } }, token));

    expect(res.status).toBe(403);
    expect((await paymentRow('tx_403')).settledAt).toBeNull();
  });
});

describe('POST /pay/api/settle — a payment made on the seller\'s OWN Stripe account (#2757)', () => {
  it('refuses to settle it on-platform: the money never touched the platform, so no balance may be credited', async () => {
    await insertPayment({ id: 'tx_byo', rail: 'stripe-byo', toDid: SELLER, externalRef: 'cs_byo' });

    const res = await POST(request({ transaction_id: 'tx_byo', fair_manifest: { chain: CHAIN } }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/own Stripe account/);
    expect((await paymentRow('tx_byo')).settledAt).toBeNull();
    // Nothing was credited and no ledger row was written.
    expect(await totalRows()).toBe(1);
    expect((await harness.client.query('SELECT 1 FROM pay.balances')).rows).toHaveLength(0);
  });

  it('still settles an ordinary platform-rail payment of the same shape', async () => {
    await insertPayment({ id: 'tx_platform', rail: 'stripe' });

    const res = await POST(request({ transaction_id: 'tx_platform', fair_manifest: { chain: CHAIN } }));

    expect(res.status).toBe(200);
  });
});

describe('POST /pay/api/settle — an app settles a payment it created (#2642)', () => {
  it('settles with its own app-service token, no shared key anywhere in the path', async () => {
    delete process.env.PAY_SERVICE_API_KEY;
    await insertPayment({ id: 'tx_ok' });

    const res = await POST(request({ transaction_id: 'tx_ok', fair_manifest: { chain: CHAIN } }));
    await flush();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ settled: true, total_amount: 10, recipients: 2, source: 'external' });
    expect(body.alreadySettled).toBeUndefined();

    // Kernel-recorded facts, not caller-supplied ones, land on the ledger rows.
    const rows = await ledgerRowsForBatch(body.batchId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([...body.transactions].sort());
    expect(rows[0]).toMatchObject({ service: 'coffee', type: 'checkout', fromDid: 'anonymous', currency: 'USD', sourceKind: 'receipt' });
    expect(rows[0].metadata).toMatchObject({ payment_id: 'tx_ok', app_did: APP_A, funded: true, funded_provider: 'stripe' });

    // The settled marker is on the checkout row; funded creators are not double-credited, the platform share is.
    const checkout = await paymentRow('tx_ok');
    expect(checkout.settledAt).not.toBeNull();
    expect(checkout.settleBatchId).toBe(body.batchId);
    expect(await harness.readBalance(harness.connA, PLATFORM, 'MJN')).toBeCloseTo(0.15);
    expect(await harness.readBalance(harness.connA, SELLER, 'MJN')).toBe(0);
  });

  it('a second settle of an already-settled payment is idempotent: same result, no double payout', async () => {
    await insertPayment({ id: 'tx_twice' });
    const first = await (await POST(request({ transaction_id: 'tx_twice', fair_manifest: { chain: CHAIN } }))).json();
    await flush();
    const rowsAfterFirst = await totalRows();

    const secondRes = await POST(request({ transaction_id: 'tx_twice', fair_manifest: { chain: CHAIN } }));
    const second = await secondRes.json();

    expect(secondRes.status).toBe(200);
    expect(second).toMatchObject({ settled: true, alreadySettled: true, batchId: first.batchId, total_amount: 10, recipients: 2 });
    expect([...second.transactions].sort()).toEqual([...first.transactions].sort());
    expect(await totalRows()).toBe(rowsAfterFirst);
    expect(await harness.readBalance(harness.connA, PLATFORM, 'MJN')).toBeCloseTo(0.15);
  });

  it('two concurrent settles of one payment pay out exactly once', async () => {
    await insertPayment({ id: 'tx_race' });

    const [a, b] = await Promise.all([
      POST(request({ transaction_id: 'tx_race', fair_manifest: { chain: CHAIN } })),
      POST(request({ transaction_id: 'tx_race', fair_manifest: { chain: CHAIN } })),
    ]);
    await flush();

    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()];
    expect(bodies[0].batchId).toBe(bodies[1].batchId);
    expect(bodies.filter((x) => x.alreadySettled)).toHaveLength(1);
    expect(await harness.readBalance(harness.connA, PLATFORM, 'MJN')).toBeCloseTo(0.15);
    expect(await totalRows()).toBe(1 + 2);
  });

  it('settles against a share-based recorded manifest (the /pay/api/checkout fairManifest shape)', async () => {
    await insertPayment({
      id: 'tx_share',
      payeeManifest: { chain: [{ did: SELLER, role: 'creator', share: 0.985 }, { did: PLATFORM, role: 'platform', share: 0.015 }] },
    });

    const res = await POST(request({ transaction_id: 'tx_share', fair_manifest: { chain: CHAIN }, total_amount: 10 }));

    expect(res.status).toBe(200);
  });

  it('settles a recorded manifest carrying taxes[] (cents) against posted taxCredits (dollars)', async () => {
    await insertPayment({
      id: 'tx_tax',
      amount: '10.50',
      payeeManifest: { chain: CHAIN, taxes: [{ jurisdiction: 'CA-ON', kind: 'HST', amount: 50, basisAmount: 1000, collectorDid: SELLER }] },
    });
    const taxCredit = { did: SELLER, amount: 0.5, jurisdiction: 'CA-ON', kind: 'HST', rateBps: 500, remitTo: 'cra', registrationNumber: 'RT0001' };

    const res = await POST(request({ transaction_id: 'tx_tax', fair_manifest: { chain: CHAIN, taxCredits: [taxCredit] } }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recipients).toBe(2);
    expect(body.transactions).toHaveLength(3);
  });

  it('only the audited manifest fields reach the ledger (extra caller fields are dropped)', async () => {
    await insertPayment({ id: 'tx_clean' });
    const dirty = CHAIN.map((c) => ({ ...c, injected: 'x' }));

    const res = await POST(request({
      transaction_id: 'tx_clean',
      fair_manifest: { chain: dirty, signature: { value: 'zz' }, provenance: [{ attestationId: 'a' }] },
      metadata: { payment_id: 'spoofed', app_did: 'did:imajin:someone-else', note: 'kept' },
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    const [row] = await ledgerRowsForBatch(body.batchId);
    expect(row.fairManifest).toEqual({ chain: CHAIN });
    // The kernel's binding fields win over caller metadata.
    expect(row.metadata).toMatchObject({ payment_id: 'tx_clean', app_did: APP_A, note: 'kept' });
  });
});

describe('POST /pay/api/settle — an app may only settle what it created, as recorded (#2642)', () => {
  async function expectRefused(transactionId: string, body: Record<string, unknown>, status: number, token = 'tok-a') {
    const before = await totalRows();
    const res = await POST(request({ transaction_id: transactionId, ...body }, token));
    expect(res.status).toBe(status);
    expect((await paymentRow(transactionId))?.settledAt ?? null).toBeNull();
    expect(await totalRows()).toBe(before);
    return res.json();
  }

  it("403: a payment created by another app", async () => {
    await insertPayment({ id: 'tx_of_b', appDid: APP_B });
    await expectRefused('tx_of_b', { fair_manifest: { chain: CHAIN } }, 403);
  });

  it('403: a payment with no app binding (user/anonymous checkout), even with a matching manifest recorded', async () => {
    await insertPayment({ id: 'tx_unbound', appDid: null, fairManifest: PAYEE_MANIFEST });
    await expectRefused('tx_unbound', { fair_manifest: { chain: CHAIN } }, 403);
  });

  it('403: a payment with no recorded payee manifest', async () => {
    await insertPayment({ id: 'tx_nomanifest', payeeManifest: null });
    const body = await expectRefused('tx_nomanifest', { fair_manifest: { chain: CHAIN } }, 403);
    expect(body.error).toMatch(/no payee manifest was recorded/);
  });

  it.each([
    ['a changed amount', [{ did: SELLER, amount: 10, role: 'creator' }, { did: PLATFORM, amount: 0.15, role: 'platform' }]],
    ['a swapped payee DID', [{ did: 'did:imajin:thief', amount: 9.85, role: 'creator' }, { did: PLATFORM, amount: 0.15, role: 'platform' }]],
    ['a changed role', [{ did: SELLER, amount: 9.85, role: 'seller' }, { did: PLATFORM, amount: 0.15, role: 'platform' }]],
    ['an extra payee', [...CHAIN, { did: 'did:imajin:thief', amount: 0.01, role: 'other' }]],
    ['a missing payee', [CHAIN[0]]],
  ])('403: a posted manifest with %s does not match the recorded payee manifest', async (_label, chain) => {
    await insertPayment({ id: 'tx_mismatch' });
    const body = await expectRefused('tx_mismatch', { fair_manifest: { chain } }, 403);
    expect(body.error).toMatch(/does not match the recorded payee manifest/);
  });

  it('403: posted taxCredits that the recorded manifest does not carry', async () => {
    await insertPayment({ id: 'tx_extra_tax' });
    const taxCredit = { did: SELLER, amount: 0.5, jurisdiction: 'CA-ON', kind: 'HST', rateBps: 500, remitTo: 'cra', registrationNumber: 'RT0001' };
    await expectRefused('tx_extra_tax', { fair_manifest: { chain: CHAIN, taxCredits: [taxCredit] } }, 403);
  });

  it('403: a posted total_amount or from_did that disagrees with the kernel record', async () => {
    await insertPayment({ id: 'tx_total' });
    await expectRefused('tx_total', { fair_manifest: { chain: CHAIN }, total_amount: 11 }, 403);
    await expectRefused('tx_total', { fair_manifest: { chain: CHAIN }, from_did: TIPPER }, 403);
  });

  it('accepts from_did when it equals the recorded payer', async () => {
    await insertPayment({ id: 'tx_payer', fromDid: TIPPER });
    const res = await POST(request({ transaction_id: 'tx_payer', fair_manifest: { chain: CHAIN }, from_did: TIPPER }));
    expect(res.status).toBe(200);
  });

  it('409: a payment the rail has not confirmed yet (pending) is never settled', async () => {
    await insertPayment({ id: 'tx_pending', status: 'pending' });
    await expectRefused('tx_pending', { fair_manifest: { chain: CHAIN } }, 409);
  });

  it('404: an unknown payment', async () => {
    const res = await POST(request({ transaction_id: 'tx_nope', fair_manifest: { chain: CHAIN } }));
    expect(res.status).toBe(404);
  });

  it('403 for app B replaying app A\'s settled payment (no prior result leaked)', async () => {
    await insertPayment({ id: 'tx_a_settled' });
    expect((await POST(request({ transaction_id: 'tx_a_settled', fair_manifest: { chain: CHAIN } }))).status).toBe(200);

    const res = await POST(request({ transaction_id: 'tx_a_settled', fair_manifest: { chain: CHAIN } }, 'tok-b'));

    expect(res.status).toBe(403);
  });
});

describe('POST /pay/api/settle — request validation', () => {
  it.each([
    ['no transaction_id', { fair_manifest: { chain: CHAIN } }],
    ['no fair_manifest', { transaction_id: 'tx_v' }],
    ['a non-array chain', { transaction_id: 'tx_v', fair_manifest: { chain: 'nope' } }],
    ['a non-numeric total_amount', { transaction_id: 'tx_v', fair_manifest: { chain: CHAIN }, total_amount: 'ten' }],
    ['a non-string from_did', { transaction_id: 'tx_v', fair_manifest: { chain: CHAIN }, from_did: 7 }],
    ['a non-object body', 'just a string'],
  ])('400: %s', async (_label, body) => {
    const res = await POST(request(body));
    expect(res.status).toBe(400);
  });

  it('400: an unparseable JSON body', async () => {
    const res = await POST(request(null, 'tok-a', '{not json'));
    expect(res.status).toBe(400);
  });

  it('403: malformed chain / tax entries never match a recorded manifest', async () => {
    await insertPayment({ id: 'tx_shape' });
    for (const fair_manifest of [
      { chain: [{ did: SELLER }] },
      { chain: CHAIN, taxCredits: 'x' },
      { chain: CHAIN, taxCredits: [{ did: SELLER }] },
      { chain: ['x'] },
    ]) {
      const res = await POST(request({ transaction_id: 'tx_shape', fair_manifest }));
      expect(res.status).toBe(403);
    }
    expect((await paymentRow('tx_shape')).settledAt).toBeNull();
  });

  it('500 with a generic body when settlement itself throws', async () => {
    await insertPayment({ id: 'tx_boom' });
    const original = mocks.dbHolder.db;
    mocks.dbHolder.db = new Proxy(original as object, {
      get: (target, prop) => {
        if (prop === 'transaction') return () => Promise.reject(new Error('db exploded'));
        const value = (target as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    try {
      const res = await POST(request({ transaction_id: 'tx_boom', fair_manifest: { chain: CHAIN } }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Settlement failed' });
    } finally {
      mocks.dbHolder.db = original;
    }
  });
});
