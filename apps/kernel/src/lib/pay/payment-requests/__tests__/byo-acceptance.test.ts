/**
 * #2754 acceptance, from the operator's seat, against a REAL Postgres (PGlite):
 * Imajin Inc has connected a restricted key; a payer opens the invoice, pays by
 * card on Imajin Inc's OWN Stripe account; Stripe calls the owner's webhook;
 * the invoice shows Paid without anyone marking it.
 *
 * Real: the payment_request service, checkout creation, card-rail selection,
 * the connector's webhook verification + republish, the `pay-stripe` reactor,
 * BYO settlement, and the drizzle schema. Faked at the edges only: Stripe's
 * HTTP API, the sealed vault / grants, the bus transport (in-process), the
 * attestation emitter, and `settlePayment` (asserted to NEVER run).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const h = vi.hoisted(() => {
  const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
  const { dirname, join } = require('node:path') as typeof import('node:path');
  const { fileURLToPath } = require('node:url') as typeof import('node:url');

  function findMigrationsDir(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 12; i++) {
      const candidate = join(dir, 'migrations');
      if (existsSync(join(candidate, '0175_pay_payment_request_paid_by_did.sql'))) return candidate;
      dir = dirname(dir);
    }
    throw new Error('could not locate migrations/ directory');
  }
  const migrationsDir = findMigrationsDir();

  return {
    readMigration: (name: string) => readFileSync(join(migrationsDir, name), 'utf-8'),
    client: null as null | { exec: (sql: string) => Promise<unknown>; query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>; close: () => Promise<void> },
    idCounter: { n: 0 },
    settlePaymentMock: vi.fn(),
    publishMock: vi.fn(),
    settledStripeAttestationMock: vi.fn(),
    keySealedMock: vi.fn(),
    resolveActiveGrantMock: vi.fn(),
    loadSealedCredentialsMock: vi.fn(),
    resolveWebhookOwnerMock: vi.fn(),
    loadAndUnsealMock: vi.fn(),
  };
});

vi.mock('@/src/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const { drizzle } = await import('drizzle-orm/pglite');
  const pay = await import('@/src/db/schemas/pay');
  const profile = await import('@/src/db/schemas/profile');

  const client = new PGlite({ extensions: { pgcrypto } });
  await client.waitReady;
  for (const name of [
    '0001_seed.sql',
    '0143_pay_payment_requests.sql',
    '0144_pay_payment_request_recipient_claim.sql',
    '0166_add_tax_registrations.sql',
    '0168_pay_payment_request_tax_amounts.sql',
    '0173_pay_payment_request_emt_pending.sql',
    '0174_profile_etransfer_email.sql',
    '0175_pay_payment_request_paid_by_did.sql',
    '0178_pay_transactions_rail_external_ref.sql',
  ]) {
    await client.exec(h.readMigration(name));
  }
  // The drizzle schema selects EVERY pay.transactions column on a read (checkout's reusable-session lookup), and the
  // migrations that add these also touch balance tables this suite has no use for — so add just the columns.
  await client.exec(`
    ALTER TABLE pay.transactions
      ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'MJN',
      ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'transfer',
      ADD COLUMN IF NOT EXISTS attestation_id text,
      ADD COLUMN IF NOT EXISTS emission_config_id text,
      ADD COLUMN IF NOT EXISTS emission_config_version integer,
      ADD COLUMN IF NOT EXISTS idempotency_key text,
      ADD COLUMN IF NOT EXISTS app_did text,
      ADD COLUMN IF NOT EXISTS payee_manifest jsonb,
      ADD COLUMN IF NOT EXISTS settled_at timestamptz,
      ADD COLUMN IF NOT EXISTS settle_batch_id text;
    ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS field_visibility jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS agent_pricing jsonb DEFAULT '{}';
  `);
  h.client = client;
  return {
    db: drizzle(client),
    paymentRequests: pay.paymentRequests,
    transactions: pay.transactions,
    profiles: profile.profiles,
    connectedAccounts: pay.connectedAccounts,
  };
});

vi.mock('@imajin/bus', async () =>
  (await import('@/src/lib/pay/__tests__/in-process-bus')).createInProcessBusMock(h.publishMock));
vi.mock('@imajin/config', () => ({ buildPublicUrlAbsolute: (name: string) => `https://kernel.test/${name}` }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_${++h.idCounter.n}` }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn().mockResolvedValue('did:imajin:node') }));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: () => ({ checkout: vi.fn() }) }));
vi.mock('@/src/lib/pay/providers/stripe-client', () => ({ getStripeClient: () => ({}) }));
vi.mock('@/src/lib/pay/checkout', () => ({ resolveConnectedAccountFee: vi.fn(), taxLineItems: () => [] }));
vi.mock('@/src/lib/pay/settle-core', () => ({ settlePayment: h.settlePaymentMock }));
vi.mock('@/src/lib/chat/connection-check', () => ({ isConnected: vi.fn() }));
vi.mock('@/src/lib/connections/payment-request-invite', () => ({ createPaymentRequestInvite: vi.fn() }));
vi.mock('@/src/lib/pay/payment-requests/attestations', () => ({
  emitPaymentRequestIssuedAttestation: vi.fn(),
  emitPaymentRequestSettledAttestation: vi.fn(),
  emitPaymentRequestSettledStripeAttestation: h.settledStripeAttestationMock,
}));
// The connector's sealed key / grants, and its routing + signing-secret custody.
vi.mock('@/src/lib/stripe/connector-core', () => ({
  STRIPE_CONNECTOR_DID: 'did:imajin:stripe-connector',
  STRIPE_EVENTS_SCOPE: 'stripe:events',
  stripe: {
    keySealed: h.keySealedMock,
    resolveActiveGrant: h.resolveActiveGrantMock,
    loadSealedCredentials: h.loadSealedCredentialsMock,
  },
}));
vi.mock('@/src/lib/vault', () => ({
  sealAndStore: vi.fn(),
  loadAndUnseal: h.loadAndUnsealMock,
  deleteFromVault: vi.fn(),
}));
vi.mock('@/src/lib/stripe/webhook-index', () => ({
  upsertWebhookIndex: vi.fn(),
  resolveWebhookOwner: h.resolveWebhookOwnerMock,
  findWebhookIndexByOwner: vi.fn(),
  deleteWebhookIndexByOwner: vi.fn(),
}));

import { createPaymentRequestCheckoutSession } from '../checkout';
import { getPaymentRequestInvoiceByHandle, getPaymentRequestById } from '../service';
import { handleVerifiedWebhookEvent } from '@/src/lib/stripe/connector';

const OWNER_DID = 'did:imajin:imajin-inc';
const PAYER_DID = 'did:imajin:customer';
const HANDLE = 'ph_d5b8';
const REQUEST_ID = 'pr_0123456789abcdef01234567';
const RESTRICTED_KEY = 'rk_live_imajininc';
const SIGNING_SECRET = 'whsec_imajininc';
const ROUTING_ID = 'stripewh_1';

const MANIFEST = {
  version: '0.4.0',
  fees: [{ role: 'processor', name: 'Stripe', rateBps: 370, minRateBps: 290, fixedCents: 30 }],
  chain: [{ did: OWNER_DID, role: 'seller', share: 1 }],
  distributions: [],
  attribution: [],
  total: { amount: 5000, currency: 'CAD' },
};

async function seedRequest(issuerDid = OWNER_DID) {
  const c = h.client!;
  await c.query('DELETE FROM pay.payment_request');
  await c.query('DELETE FROM pay.transactions');
  await c.query(
    `INSERT INTO pay.payment_request
       (id, kind, issuer_did, payee_account, recipient_did, line_items, currency, total_amount, subtotal_amount,
        tax_total_amount, fair_manifest, allow_on_platform, status, content_hash, pay_handle)
     VALUES ($1, 'invoice', $2, $2, $3, $4::jsonb, 'CAD', 5000, 5000, 0, $5::jsonb, true, 'issued', 'bafy-hash', $6)`,
    [REQUEST_ID, issuerDid, PAYER_DID, JSON.stringify([{ name: 'Consulting', amount: 5000, quantity: 1 }]), JSON.stringify(MANIFEST), HANDLE],
  );
}

async function setProfile(etransferEmail: string | null) {
  await h.client!.query('DELETE FROM profile.profiles WHERE did = $1', [OWNER_DID]);
  await h.client!.query(`INSERT INTO profile.profiles (did, display_name, etransfer_email) VALUES ($1, 'Imajin Inc', $2)`, [OWNER_DID, etransferEmail]);
}

/** A genuinely signed delivery from the owner's own Stripe account for `paymentIntentId`. */
function signedPaymentIntentSucceeded(
  fields: { paymentIntentId?: string; amount?: number; currency?: string; metadata?: Record<string, string> },
) {
  const payload = {
    id: `evt_${fields.paymentIntentId ?? 'pi_paid'}`,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: fields.paymentIntentId ?? 'pi_paid',
        amount: fields.amount ?? 5000,
        currency: (fields.currency ?? 'CAD').toLowerCase(),
        metadata: fields.metadata ?? {},
      },
    },
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', SIGNING_SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return { rawBody, header: `t=${timestamp},v1=${signature}` };
}

async function rowStatus(): Promise<string> {
  return (await h.client!.query<{ status: string }>('SELECT status FROM pay.payment_request WHERE id = $1', [REQUEST_ID])).rows[0]!.status;
}

/** The PaymentIntent metadata Stripe will echo back, read off the form the kernel sent to Stripe at checkout. */
function metadataSentToStripe(fetchSpy: ReturnType<typeof vi.fn>): Record<string, string> {
  const form = new URLSearchParams(fetchSpy.mock.calls[0][1].body as string);
  const metadata: Record<string, string> = {};
  for (const [key, value] of form) {
    const match = /^payment_intent_data\[metadata\]\[(.+)\]$/.exec(key);
    if (match) metadata[match[1]] = value;
  }
  return metadata;
}

beforeAll(async () => {
  await import('@/src/db');
});

afterAll(async () => {
  await h.client?.close();
});

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  h.idCounter.n = 0;
  h.settlePaymentMock.mockReset();
  h.publishMock.mockReset().mockResolvedValue(undefined);
  h.settledStripeAttestationMock.mockReset().mockResolvedValue('att_1');
  // Imajin Inc has connected a restricted key and granted the events scope.
  h.keySealedMock.mockReset().mockResolvedValue(true);
  h.resolveActiveGrantMock.mockReset().mockResolvedValue(true);
  h.loadSealedCredentialsMock.mockReset().mockResolvedValue({ apiKey: RESTRICTED_KEY });
  h.resolveWebhookOwnerMock.mockReset().mockResolvedValue({ ownerDid: OWNER_DID, endpointId: 'we_1' });
  h.loadAndUnsealMock.mockReset().mockResolvedValue(SIGNING_SECRET);
  fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1', expires_at: 1_900_000_000 }),
  }));
  vi.stubGlobal('fetch', fetchSpy);
  await setProfile(null); // no e-Transfer email: the card rail is the ONLY way to pay
  await seedRequest();
});

describe('#2754 acceptance — Imajin Inc connects a restricted key, issues an invoice, the payer pays by card', () => {
  it('the pay page offers card (and only card), the charge runs on the issuer\'s own account, and the invoice becomes Paid with no manual marking', async () => {
    // 1. The pay page: a card button, no e-Transfer, no "can't be paid online".
    const before = await getPaymentRequestInvoiceByHandle(HANDLE);
    expect(before).toMatchObject({ status: 'issued', card: true, emt: null });

    // 2. The payer presses Pay: a Checkout Session is created with the ISSUER'S key, on the issuer's account.
    const session = await createPaymentRequestCheckoutSession({ id: HANDLE, callerDid: PAYER_DID });
    expect(session).toMatchObject({ id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1', reused: false });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.headers.Authorization).toBe(`Bearer ${RESTRICTED_KEY}`);
    const form = new URLSearchParams(init.body as string);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('5000');
    expect(form.get('success_url')).toBe(`https://kernel.test/pay/r/${HANDLE}`);
    expect([...form.keys()].join(' ')).not.toMatch(/transfer_data|application_fee/);
    expect(await rowStatus()).toBe('issued'); // nothing is Paid until the money actually lands

    // 3. The payer pays; Stripe calls the owner's webhook with the PaymentIntent the session created.
    const metadata = metadataSentToStripe(fetchSpy);
    expect(metadata).toMatchObject({ payment_request_id: REQUEST_ID, payHandle: HANDLE });
    const { rawBody, header } = signedPaymentIntentSucceeded({ metadata });
    const delivery = await handleVerifiedWebhookEvent(ROUTING_ID, rawBody, header);
    expect(delivery).toEqual({ status: 'ok', published: true });

    // 4. The invoice shows Paid — nobody marked it.
    expect(await rowStatus()).toBe('paid');
    const after = await getPaymentRequestInvoiceByHandle(HANDLE);
    expect(after).toMatchObject({ status: 'paid', card: false, emt: null });
    expect(after?.settlement?.method).toBe('stripe');
    expect(after?.paidAt).toBeTruthy();

    // The ledger side: a completed BYO-rail row with the PaymentIntent as external_ref and a 0 platform fee...
    const txs = (await h.client!.query<Record<string, unknown>>(`SELECT * FROM pay.transactions WHERE rail = 'stripe-byo' AND status = 'completed'`)).rows;
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ external_ref: 'pi_paid', to_did: OWNER_DID, service: 'payment_request' });
    expect(txs[0].fair_manifest).toMatchObject({ platformFee: { rateBps: 0, amountCents: 0 } });
    // ...and the platform balance never moved.
    expect(h.settlePaymentMock).not.toHaveBeenCalled();
    // The settlement is attested and announced like every other rail.
    expect(h.settledStripeAttestationMock).toHaveBeenCalledOnce();
    expect(h.publishMock).toHaveBeenCalledWith('payment_request.paid', expect.objectContaining({ issuer: OWNER_DID }));
    expect(h.publishMock).toHaveBeenCalledWith('payment_request.settled', expect.anything());
  });

  it('a replayed delivery changes nothing', async () => {
    await createPaymentRequestCheckoutSession({ id: HANDLE, callerDid: PAYER_DID });
    const { rawBody, header } = signedPaymentIntentSucceeded({ metadata: metadataSentToStripe(fetchSpy) });

    await handleVerifiedWebhookEvent(ROUTING_ID, rawBody, header);
    await handleVerifiedWebhookEvent(ROUTING_ID, rawBody, header);

    expect(await rowStatus()).toBe('paid');
    const txs = (await h.client!.query(`SELECT id FROM pay.transactions WHERE rail = 'stripe-byo' AND status = 'completed'`)).rows;
    expect(txs).toHaveLength(1);
    expect(h.settledStripeAttestationMock).toHaveBeenCalledOnce();
  });

  it('a payment of a different amount does not mark the invoice Paid', async () => {
    await createPaymentRequestCheckoutSession({ id: HANDLE, callerDid: PAYER_DID });
    const { rawBody, header } = signedPaymentIntentSucceeded({ amount: 100, metadata: metadataSentToStripe(fetchSpy) });

    await handleVerifiedWebhookEvent(ROUTING_ID, rawBody, header);

    expect(await rowStatus()).toBe('issued');
  });

  it('an unrelated PaymentIntent on the owner\'s account (no payment_request metadata) never touches the ledger', async () => {
    const { rawBody, header } = signedPaymentIntentSucceeded({ paymentIntentId: 'pi_unrelated', metadata: {} });

    await handleVerifiedWebhookEvent(ROUTING_ID, rawBody, header);

    expect(await rowStatus()).toBe('issued');
    expect((await h.client!.query('SELECT id FROM pay.transactions')).rows).toHaveLength(0);
    expect(h.settlePaymentMock).not.toHaveBeenCalled();
  });

  it('another owner\'s Stripe account cannot settle Imajin Inc\'s invoice, even naming its id in metadata', async () => {
    h.resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: 'did:imajin:someone-else', endpointId: 'we_9' });
    const { rawBody, header } = signedPaymentIntentSucceeded({ metadata: { payment_request_id: REQUEST_ID } });

    await handleVerifiedWebhookEvent(ROUTING_ID, rawBody, header);

    expect(await rowStatus()).toBe('issued');
    expect((await getPaymentRequestById(REQUEST_ID))?.settlementRef).toBeNull();
    expect((await h.client!.query('SELECT id FROM pay.transactions')).rows).toHaveLength(0);
  });

  it('a delivery with a bad signature settles nothing', async () => {
    await createPaymentRequestCheckoutSession({ id: HANDLE, callerDid: PAYER_DID });
    const { rawBody } = signedPaymentIntentSucceeded({ metadata: metadataSentToStripe(fetchSpy) });

    const delivery = await handleVerifiedWebhookEvent(ROUTING_ID, rawBody, `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`);

    expect(delivery).toMatchObject({ status: 'invalid_signature' });
    expect(await rowStatus()).toBe('issued');
  });
});

describe('#2754 acceptance — an issuer with no card rail', () => {
  it('without a connector (and no Connect) the page offers no card, and the checkout API refuses with a typed 400', async () => {
    h.keySealedMock.mockResolvedValue(false);
    h.resolveActiveGrantMock.mockResolvedValue(false);

    expect(await getPaymentRequestInvoiceByHandle(HANDLE)).toMatchObject({ card: false, emt: null });

    const result = await createPaymentRequestCheckoutSession({ id: HANDLE, callerDid: PAYER_DID });
    expect(result).toMatchObject({ status: 400, code: 'SELLER_NOT_CONNECTED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a key that is sealed but whose events scope was never granted is not offered either — it could charge but never settle', async () => {
    h.resolveActiveGrantMock.mockResolvedValue(false);

    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.card).toBe(false);
  });

  it('only an e-Transfer email: the page offers e-Transfer and no card', async () => {
    h.keySealedMock.mockResolvedValue(false);
    await setProfile('pay@imajin.example');

    expect(await getPaymentRequestInvoiceByHandle(HANDLE)).toMatchObject({ card: false, emt: { state: 'available' } });
  });
});

describe('#2754 — Stripe refusing the issuer\'s key at pay time is a specific, typed error', () => {
  it('a revoked/under-permissioned key surfaces CARD_RAIL_KEY_REJECTED (a 502), and nothing is recorded', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { type: 'permission_error', message: 'restricted key lacks Checkout Sessions = Write' } }),
    });

    const result = await createPaymentRequestCheckoutSession({ id: HANDLE, callerDid: PAYER_DID });

    expect(result).toMatchObject({ status: 502, code: 'CARD_RAIL_KEY_REJECTED' });
    expect((await h.client!.query('SELECT id FROM pay.transactions')).rows).toHaveLength(0);
    expect(await rowStatus()).toBe('issued');
  });
});
