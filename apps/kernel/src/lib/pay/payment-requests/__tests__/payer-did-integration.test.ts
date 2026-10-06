/**
 * #2656 Phase 2 — the payer chooses which of their DIDs pays a payment request,
 * end to end against a REAL Postgres (PGlite) through the real drizzle schema
 * and the real service code: migration 0175, the owner/admin control rule over
 * `auth.identity_members`, server-side rejection of a DID the payer can't act
 * for, and `paid_by_did` flowing through BOTH settle rails (card webhook and
 * e-Transfer mark-paid) into the ledger payer, the .fair buyer, the settlement
 * attestation, the bus events and the receipt.
 *
 * Mocked: settle-core (ledger — asserted on, never run), the bus, the
 * attestation emitters, node identity, and Stripe plumbing. `@imajin/fair`'s
 * `resolveSettlementChain` runs for REAL, so the .fair buyer is the actual maths.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Heavy suite (embedded PGlite): the 5000ms default is too tight on contended CI runners (#2548). Scoped to this file.
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
    settlePaymentMock: vi.fn(),
    settledStripeAttestationMock: vi.fn(),
    settledAttestationMock: vi.fn(),
    publishMock: vi.fn(),
    payCheckoutMock: vi.fn(),
    stripeRetrieveMock: vi.fn(),
    idCounter: { n: 0 },
  };
});

vi.mock('@/src/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const { drizzle } = await import('drizzle-orm/pglite');
  const pay = await import('@/src/db/schemas/pay');
  const profile = await import('@/src/db/schemas/profile');
  const auth = await import('@/src/db/schemas/auth');

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
  ]) {
    await client.exec(h.readMigration(name));
  }
  await client.exec(`
    ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS field_visibility jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS agent_pricing jsonb DEFAULT '{}';
    -- The drizzle transactions table also reads these ledger columns, added by migrations unrelated to this suite.
    ALTER TABLE pay.transactions
      ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'MJN',
      ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'transfer',
      ADD COLUMN IF NOT EXISTS attestation_id text,
      ADD COLUMN IF NOT EXISTS emission_config_id text,
      ADD COLUMN IF NOT EXISTS emission_config_version integer,
      ADD COLUMN IF NOT EXISTS idempotency_key text;
  `);
  h.client = client;
  return {
    db: drizzle(client),
    paymentRequests: pay.paymentRequests,
    transactions: pay.transactions,
    profiles: profile.profiles,
    identityMembers: auth.identityMembers,
  };
});

vi.mock('@imajin/bus', () => ({ publish: h.publishMock }));
vi.mock('@imajin/config', () => ({ buildPublicUrlAbsolute: (name: string) => `https://kernel.test/${name}` }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_${++h.idCounter.n}` }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn().mockResolvedValue('did:imajin:node') }));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: () => ({ checkout: h.payCheckoutMock }) }));
vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ checkout: { sessions: { retrieve: h.stripeRetrieveMock } } }),
}));
vi.mock('@/src/lib/pay/checkout', () => ({
  resolveConnectedAccountFee: vi.fn().mockResolvedValue({ ok: true, connectedAccountId: 'acct_1', applicationFeeAmount: 0 }),
  taxLineItems: () => [],
}));
vi.mock('@/src/lib/pay/settle-core', () => ({ settlePayment: h.settlePaymentMock }));
vi.mock('@/src/lib/chat/connection-check', () => ({ isConnected: vi.fn() }));
vi.mock('@/src/lib/connections/payment-request-invite', () => ({ createPaymentRequestInvite: vi.fn() }));
vi.mock('@/src/lib/pay/payment-requests/attestations', () => ({
  emitPaymentRequestIssuedAttestation: vi.fn(),
  emitPaymentRequestSettledAttestation: h.settledAttestationMock,
  emitPaymentRequestSettledStripeAttestation: h.settledStripeAttestationMock,
}));

import { requestEmtPayInstructions, settlePaymentRequestEmt } from '../emt';
import { createPaymentRequestCheckoutSession, settlePaymentRequestFromStripeCheckout } from '../checkout';
import {
  controlsPayerDid,
  getPayerDidChoices,
  listControlledPayerDids,
  payerPersonDidOf,
  resolvePayerDidChoice,
} from '../payer-dids';
import { getPaymentRequestById, getPaymentRequestInvoiceByHandle } from '../service';

const ISSUER_DID = 'did:imajin:ryan';
const ERIC = 'did:imajin:eric';
const ARTIFACT = 'did:imajin:artifact';
const MEMBER_ORG = 'did:imajin:member-org';
const MAINTAINER_ORG = 'did:imajin:maintainer-org';
const REMOVED_ORG = 'did:imajin:removed-org';
const EVENTS_ONLY_ORG = 'did:imajin:events-only-org';
const PAY_SCOPED_ORG = 'did:imajin:pay-scoped-org';
const STRANGER_ORG = 'did:imajin:stranger-org';
const HANDLE = 'ph_handle_1';
const REQUEST_ID = 'pr_0123456789abcdef01234567';
const EMT_EMAIL = 'ryan@acme.example';

const MANIFEST = {
  version: '0.4.0',
  fees: [{ role: 'processor', name: 'Stripe', rateBps: 370, minRateBps: 290, fixedCents: 30 }],
  // A buyer share (BUYER_PLACEHOLDER) makes the .fair buyer observable: it must resolve to the PAYING DID.
  chain: [
    { did: ISSUER_DID, role: 'seller', share: 0.9 },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer', share: 0.1 },
  ],
  distributions: [],
  attribution: [],
  total: { amount: 5000, currency: 'CAD' },
};

async function seedRequest(overrides: { status?: string } = {}) {
  const c = h.client!;
  await c.query('DELETE FROM pay.transactions');
  await c.query('DELETE FROM pay.payment_request');
  await c.query(
    `INSERT INTO pay.payment_request
       (id, kind, issuer_did, payee_account, recipient_did, line_items, currency, total_amount, subtotal_amount,
        tax_total_amount, fair_manifest, allow_on_platform, status, content_hash, pay_handle)
     VALUES ($1, 'invoice', $2, $2, $3, $4::jsonb, 'CAD', 5000, 5000, 0, $5::jsonb, true, $6, 'bafy-hash', $7)`,
    [
      REQUEST_ID,
      ISSUER_DID,
      ERIC,
      JSON.stringify([{ name: 'Consulting', amount: 5000, quantity: 1 }]),
      JSON.stringify(MANIFEST),
      overrides.status ?? 'issued',
      HANDLE,
    ],
  );
}

async function seedMembership(
  identityDid: string,
  memberDid: string,
  role: string,
  opts: { removed?: boolean; allowedServices?: string[] | null } = {},
) {
  await h.client!.query(
    `INSERT INTO auth.identity_members (identity_did, member_did, role, removed_at, allowed_services)
     VALUES ($1, $2, $3, $4, $5)`,
    [identityDid, memberDid, role, opts.removed ? new Date().toISOString() : null, opts.allowedServices ?? null],
  );
}

async function seedProfiles() {
  const c = h.client!;
  await c.query('DELETE FROM profile.profiles');
  await c.query(
    `INSERT INTO profile.profiles (did, display_name, etransfer_email) VALUES
       ($1, 'Ryan Co', $4), ($2, 'Eric', NULL), ($3, 'Artifact', NULL)`,
    [ISSUER_DID, ERIC, ARTIFACT, EMT_EMAIL],
  );
}

async function seedMemberships() {
  const c = h.client!;
  await c.query('DELETE FROM auth.identity_members');
  await seedMembership(ARTIFACT, ERIC, 'owner');
  await seedMembership(PAY_SCOPED_ORG, ERIC, 'admin', { allowedServices: ['events', 'pay'] });
  await seedMembership(MEMBER_ORG, ERIC, 'member');
  await seedMembership(MAINTAINER_ORG, ERIC, 'maintainer');
  await seedMembership(REMOVED_ORG, ERIC, 'owner', { removed: true });
  await seedMembership(EVENTS_ONLY_ORG, ERIC, 'owner', { allowedServices: ['events'] });
  // A stranger's org that Eric has nothing to do with.
  await seedMembership(STRANGER_ORG, 'did:imajin:someone-else', 'owner');
}

async function paidByDidColumn(): Promise<string | null> {
  const res = await h.client!.query<{ paid_by_did: string | null }>('SELECT paid_by_did FROM pay.payment_request WHERE id = $1', [REQUEST_ID]);
  return res.rows[0]!.paid_by_did;
}

beforeAll(async () => {
  await import('@/src/db');
});

afterAll(async () => {
  await h.client?.close();
});

beforeEach(async () => {
  h.settlePaymentMock.mockReset().mockResolvedValue({ success: true });
  h.settledStripeAttestationMock.mockReset().mockResolvedValue('att_stripe_1');
  h.settledAttestationMock.mockReset().mockResolvedValue('att_emt_1');
  h.publishMock.mockReset().mockResolvedValue(undefined);
  h.payCheckoutMock.mockReset().mockResolvedValue({
    id: 'cs_new',
    url: 'https://checkout.stripe.com/cs_new',
    expiresAt: new Date('2026-01-01T01:00:00Z'),
  });
  h.stripeRetrieveMock.mockReset();
  await seedProfiles();
  await seedMemberships();
  await seedRequest();
});

const stripeInput = { paymentRequestId: REQUEST_ID, checkoutSessionId: 'cs_new', paymentIntentId: 'pi_1' };

describe('migration 0175 — paid_by_did', () => {
  it('adds a nullable column that defaults to NULL, so every existing request still settles as its recipient', async () => {
    expect(await paidByDidColumn()).toBeNull();
  });

  it('is idempotent — re-running it is a no-op that keeps a stored value', async () => {
    await h.client!.query('UPDATE pay.payment_request SET paid_by_did = $1 WHERE id = $2', [ARTIFACT, REQUEST_ID]);
    await h.client!.exec(h.readMigration('0175_pay_payment_request_paid_by_did.sql'));
    expect(await paidByDidColumn()).toBe(ARTIFACT);
  });
});

describe('which DIDs a person controls', () => {
  it("offers the person's own DID first, then only orgs where they are owner/admin with an active, pay-capable membership", async () => {
    const options = await listControlledPayerDids(ERIC);
    expect(options).toEqual([
      { did: ERIC, kind: 'personal', displayName: 'Eric' },
      // sorted by display name; an org with no profile falls back to a truncated DID
      { did: ARTIFACT, kind: 'organization', displayName: 'Artifact' },
      { did: PAY_SCOPED_ORG, kind: 'organization', displayName: 'did:imajin:pay-s' },
    ]);
  });

  it.each([
    ['a plain member', MEMBER_ORG],
    ['a maintainer', MAINTAINER_ORG],
    ['a removed owner', REMOVED_ORG],
    ['an owner whose membership is scoped away from pay', EVENTS_ONLY_ORG],
    ["somebody else's org", STRANGER_ORG],
  ])('never offers — and does not control — an org where the person is %s', async (_label, orgDid) => {
    expect((await listControlledPayerDids(ERIC)).map((o) => o.did)).not.toContain(orgDid);
    expect(await controlsPayerDid(ERIC, orgDid)).toBe(false);
  });

  it('controls their own DID and an owned org', async () => {
    expect(await controlsPayerDid(ERIC, ERIC)).toBe(true);
    expect(await controlsPayerDid(ERIC, ARTIFACT)).toBe(true);
  });

  it('resolves no choice to null, a controlled DID to itself, and an uncontrolled DID to a 403', async () => {
    expect(await resolvePayerDidChoice(undefined, ERIC)).toBeNull();
    expect(await resolvePayerDidChoice(ARTIFACT, ERIC)).toBe(ARTIFACT);
    expect(await resolvePayerDidChoice(STRANGER_ORG, ERIC)).toMatchObject({ status: 403 });
  });

  it('an agent acting for a human is checked against the human, not the agent', () => {
    expect(payerPersonDidOf({ id: 'did:imajin:agent', actingFor: ERIC })).toBe(ERIC);
    expect(payerPersonDidOf({ id: ERIC, actingAs: ARTIFACT })).toBe(ERIC);
  });
});

describe('GET payer-dids data — what the "Pay as" picker is offered', () => {
  it('Eric sees himself and Artifact, with his own invoice recipient DID preselected', async () => {
    const choices = await getPayerDidChoices(HANDLE, { id: ERIC });
    expect(choices).toMatchObject({ defaultDid: ERIC });
    expect('dids' in choices && choices.dids.map((d) => d.did)).toEqual([ERIC, ARTIFACT, PAY_SCOPED_ORG]);
  });

  it('preselects the DID the caller is acting as when the recipient is not one they control', async () => {
    await h.client!.query('UPDATE pay.payment_request SET recipient_did = $1', [STRANGER_ORG]);
    expect(await getPayerDidChoices(HANDLE, { id: ERIC, actingAs: ARTIFACT })).toMatchObject({ defaultDid: ARTIFACT });
    expect(await getPayerDidChoices(HANDLE, { id: ERIC })).toMatchObject({ defaultDid: ERIC });
  });

  it('a stranger is offered only themselves — never Eric’s orgs', async () => {
    const choices = await getPayerDidChoices(HANDLE, { id: 'did:imajin:stranger' });
    expect('dids' in choices && choices.dids.map((d) => d.did)).toEqual(['did:imajin:stranger']);
  });

  it('404s an unknown handle and a void request', async () => {
    expect(await getPayerDidChoices('nope', { id: ERIC })).toMatchObject({ status: 404 });
    await h.client!.query("UPDATE pay.payment_request SET status = 'void'");
    expect(await getPayerDidChoices(HANDLE, { id: ERIC })).toMatchObject({ status: 404 });
  });
});

describe('card: checkout stores a validated paid_by_did, and the webhook settles as it', () => {
  it('personal pay — Eric pays as himself: stored, and the ledger payer, .fair buyer, attestation and events name Eric', async () => {
    const session = await createPaymentRequestCheckoutSession({
      id: HANDLE, // the pay page only has the opaque handle
      callerDid: ERIC,
      paidByDid: ERIC,
      payerPersonDid: ERIC,
    });
    expect(session).toMatchObject({ id: 'cs_new', reused: false });
    expect(await paidByDidColumn()).toBe(ERIC);

    const result = await settlePaymentRequestFromStripeCheckout(stripeInput);
    expect('settled' in result && result.settled).toBe(true);

    const settleArgs = h.settlePaymentMock.mock.calls[0]![0];
    expect(settleArgs.from_did).toBe(ERIC);
    expect(settleArgs.fair_manifest.chain.find((e: { role: string }) => e.role === 'buyer').did).toBe(ERIC);
    expect(h.settledStripeAttestationMock.mock.calls[0]![0]).toMatchObject({ paidByDid: ERIC, recipientDid: ERIC });
  });

  it('business pay — Eric pays as Artifact: Artifact is the payer everywhere, the invoice stays addressed to Eric, and the issuer can see who paid', async () => {
    const session = await createPaymentRequestCheckoutSession({
      id: REQUEST_ID,
      callerDid: ERIC,
      paidByDid: ARTIFACT,
      payerPersonDid: ERIC,
    });
    expect(session).toMatchObject({ id: 'cs_new' });
    expect(await paidByDidColumn()).toBe(ARTIFACT);

    // The pending checkout transaction is attributed to the paying DID too.
    const pending = await h.client!.query<{ from_did: string }>("SELECT from_did FROM pay.transactions WHERE status = 'pending'");
    expect(pending.rows[0]!.from_did).toBe(ARTIFACT);

    const result = await settlePaymentRequestFromStripeCheckout(stripeInput);
    expect('paymentRequest' in result && result.paymentRequest).toMatchObject({ paidByDid: ARTIFACT, recipientDid: ERIC });

    // Ledger payer + .fair buyer.
    const settleArgs = h.settlePaymentMock.mock.calls[0]![0];
    expect(settleArgs.from_did).toBe(ARTIFACT);
    expect(settleArgs.fair_manifest.chain.find((e: { role: string }) => e.role === 'buyer').did).toBe(ARTIFACT);

    // Attestation names the paying DID; the subject stays the invoice's recipient.
    expect(h.settledStripeAttestationMock.mock.calls[0]![0]).toMatchObject({ paidByDid: ARTIFACT, recipientDid: ERIC });

    // Events (what the issuer's feed/notifications are built from) carry it as well.
    const published = Object.fromEntries(h.publishMock.mock.calls.map(([event, body]) => [event, body]));
    expect(published['payment_request.paid'].payload).toMatchObject({ paidByDid: ARTIFACT, recipientDid: ERIC });
    expect(published['payment_request.settled'].payload).toMatchObject({ paidByDid: ARTIFACT, method: 'stripe' });
    expect(published['payment_request.settled'].subject).toBe(ERIC);

    // Persisted on the row the issuer reads back.
    expect((await getPaymentRequestById(REQUEST_ID))?.paidByDid).toBe(ARTIFACT);
  });

  it('with no choice the request settles as its recipient, exactly as before', async () => {
    await createPaymentRequestCheckoutSession({ id: REQUEST_ID, callerDid: ERIC });
    expect(await paidByDidColumn()).toBeNull();

    await settlePaymentRequestFromStripeCheckout(stripeInput);

    expect(h.settlePaymentMock.mock.calls[0]![0].from_did).toBe(ERIC);
    expect(h.settledStripeAttestationMock.mock.calls[0]![0]).toMatchObject({ paidByDid: ERIC });
  });

  it('unauthorized DID — rejected with a 403, never stored, and no Stripe session is created', async () => {
    const result = await createPaymentRequestCheckoutSession({
      id: REQUEST_ID,
      callerDid: ERIC,
      paidByDid: STRANGER_ORG,
      payerPersonDid: ERIC,
    });
    expect(result).toMatchObject({ status: 403 });
    expect(await paidByDidColumn()).toBeNull();
    expect(h.payCheckoutMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a plain member', MEMBER_ORG],
    ['a maintainer', MAINTAINER_ORG],
    ['a removed owner', REMOVED_ORG],
  ])('unauthorized DID — an org where Eric is %s cannot pay either', async (_label, orgDid) => {
    const result = await createPaymentRequestCheckoutSession({ id: REQUEST_ID, callerDid: ERIC, paidByDid: orgDid, payerPersonDid: ERIC });
    expect(result).toMatchObject({ status: 403 });
    expect(await paidByDidColumn()).toBeNull();
  });

  it('a stranger who is neither issuer nor recipient is refused before the DID choice is even considered', async () => {
    const result = await createPaymentRequestCheckoutSession({
      id: REQUEST_ID,
      callerDid: 'did:imajin:stranger',
      paidByDid: 'did:imajin:stranger',
    });
    expect(result).toMatchObject({ status: 403 });
    expect(await paidByDidColumn()).toBeNull();
  });

  it('the last choice before payment wins, and a settled request can no longer be re-pointed', async () => {
    await createPaymentRequestCheckoutSession({ id: REQUEST_ID, callerDid: ERIC, paidByDid: ARTIFACT, payerPersonDid: ERIC });
    h.stripeRetrieveMock.mockResolvedValue({ status: 'open', url: 'https://checkout.stripe.com/cs_new', id: 'cs_new', expires_at: 1_800_000_000 });
    const second = await createPaymentRequestCheckoutSession({ id: REQUEST_ID, callerDid: ERIC, paidByDid: ERIC, payerPersonDid: ERIC });
    expect(second).toMatchObject({ reused: true });
    expect(await paidByDidColumn()).toBe(ERIC);

    await settlePaymentRequestFromStripeCheckout(stripeInput);
    const afterPaid = await createPaymentRequestCheckoutSession({ id: REQUEST_ID, callerDid: ERIC, paidByDid: ARTIFACT, payerPersonDid: ERIC });
    expect(afterPaid).toMatchObject({ status: 409 });
    expect(await paidByDidColumn()).toBe(ERIC);
  });
});

describe('e-Transfer: the chosen DID is recorded when the payer picks the rail, and carried by Mark paid', () => {
  it('business pay — Artifact is recorded at choice time, then names the payer on settlement, attestation and event', async () => {
    const instructions = await requestEmtPayInstructions(HANDLE, { paidByDid: ARTIFACT, personDid: ERIC });
    expect('instructions' in instructions).toBe(true);
    expect(await paidByDidColumn()).toBe(ARTIFACT);

    const settled = await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });
    expect('settled' in settled && settled.settled).toBe(true);

    const settleArgs = h.settlePaymentMock.mock.calls[0]![0];
    expect(settleArgs.from_did).toBe(ARTIFACT);
    expect(settleArgs.funded_provider).toBe('emt');
    expect(settleArgs.fair_manifest.chain.find((e: { role: string }) => e.role === 'buyer').did).toBe(ARTIFACT);
    expect(h.settledAttestationMock.mock.calls[0]![0]).toMatchObject({ method: 'emt', paidByDid: ARTIFACT, recipientDid: ERIC });
    const settledEvent = h.publishMock.mock.calls.find(([event]) => event === 'payment_request.settled')![1];
    expect(settledEvent.payload).toMatchObject({ method: 'emt', paidByDid: ARTIFACT, recipientDid: ERIC });
  });

  it('personal pay — Eric as himself, and an anonymous payer (no choice) settles as the recipient', async () => {
    await requestEmtPayInstructions(HANDLE, { paidByDid: ERIC, personDid: ERIC });
    expect(await paidByDidColumn()).toBe(ERIC);
    await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });
    expect(h.settlePaymentMock.mock.calls[0]![0].from_did).toBe(ERIC);

    await seedRequest();
    h.settlePaymentMock.mockClear();
    await requestEmtPayInstructions(HANDLE);
    expect(await paidByDidColumn()).toBeNull();
    await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });
    expect(h.settlePaymentMock.mock.calls[0]![0].from_did).toBe(ERIC);
    expect(h.settledAttestationMock.mock.calls.at(-1)![0]).toMatchObject({ paidByDid: ERIC });
  });

  it('unauthorized DID — a 403, request left untouched (still issued, nothing stored)', async () => {
    const result = await requestEmtPayInstructions(HANDLE, { paidByDid: STRANGER_ORG, personDid: ERIC });
    expect(result).toMatchObject({ status: 403 });
    expect(await paidByDidColumn()).toBeNull();
    const row = await getPaymentRequestById(REQUEST_ID);
    expect(row?.status).toBe('issued');
  });

  it('asking again with no choice keeps the earlier one (the instructions replay is read-only)', async () => {
    await requestEmtPayInstructions(HANDLE, { paidByDid: ARTIFACT, personDid: ERIC });
    await requestEmtPayInstructions(HANDLE);
    expect(await paidByDidColumn()).toBe(ARTIFACT);
  });
});

describe('the receipt names the paying DID', () => {
  it('shows Artifact (name and DID) once Eric paid as Artifact', async () => {
    await createPaymentRequestCheckoutSession({ id: REQUEST_ID, callerDid: ERIC, paidByDid: ARTIFACT, payerPersonDid: ERIC });
    await settlePaymentRequestFromStripeCheckout(stripeInput);

    const view = await getPaymentRequestInvoiceByHandle(HANDLE);
    expect(view?.paidBy).toEqual({ did: ARTIFACT, displayName: 'Artifact' });
  });

  it('falls back to the recipient when no payer was chosen', async () => {
    await settlePaymentRequestFromStripeCheckout(stripeInput);
    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.paidBy).toEqual({ did: ERIC, displayName: 'Eric' });
  });

  it('names nobody while the request is still open', async () => {
    await createPaymentRequestCheckoutSession({ id: REQUEST_ID, callerDid: ERIC, paidByDid: ARTIFACT, payerPersonDid: ERIC });
    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.paidBy).toBeNull();
  });
});
