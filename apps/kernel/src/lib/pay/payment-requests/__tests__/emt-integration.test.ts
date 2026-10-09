/**
 * #2665 — the e-Transfer pay-in flow end to end against a REAL Postgres
 * (PGlite) through the real drizzle schema and the real service code, so the
 * guarantees that only a database can give are actually exercised: the guarded
 * `UPDATE ... WHERE status IN (...)` compare-and-swap, the widened status
 * CHECK (migration 0173), and the owner-editable `etransfer_email` column
 * (migration 0174).
 *
 * Mocked: settle-core (ledger — asserted on, never run), the bus, the
 * attestation emitters, node identity, and Stripe/checkout plumbing.
 * `@imajin/fair`'s `resolveSettlementChain` runs for REAL, so "no processor
 * fee" is checked against the actual `.fair` maths.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Heavy suite (embedded PGlite): the 5000ms default is too tight on contended CI runners (#2548). Scoped to this file.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Everything the hoisted `vi.mock` factories touch must live in `vi.hoisted` — including the migration reader.
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
    resolveCardRailMock: vi.fn(),
    settledStripeAttestationMock: vi.fn(),
    settledAttestationMock: vi.fn(),
    publishMock: vi.fn(),
  };
});
const readMigration = h.readMigration;

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
    // #2656: the drizzle schema now selects `paid_by_did` on every read of the request.
    '0175_pay_payment_request_paid_by_did.sql',
    // #2176: the drizzle schema now selects `rail` / `external_ref` on every read of pay.transactions.
    '0178_pay_transactions_rail_external_ref.sql',
  ]) {
    await client.exec(h.readMigration(name));
  }
  // `getPaymentRequestInvoiceByHandle` reads the whole profile row (drizzle `select()`), so the two profile columns
  // the replayed migrations above don't create are added directly: 0014/0057 also seed unrelated bus rows this suite has no tables for.
  await client.exec(`
    ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS field_visibility jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS agent_pricing jsonb DEFAULT '{}';
  `);
  h.client = client;
  return {
    db: drizzle(client),
    paymentRequests: pay.paymentRequests,
    transactions: pay.transactions,
    profiles: profile.profiles,
  };
});

vi.mock('@imajin/bus', () => ({ publish: h.publishMock }));
vi.mock('@imajin/config', () => ({ buildPublicUrlAbsolute: (name: string) => `https://kernel.test/${name}` }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn().mockResolvedValue('did:imajin:node') }));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: () => ({ checkout: vi.fn() }) }));
vi.mock('@/src/lib/pay/providers/stripe-client', () => ({ getStripeClient: () => ({}) }));
vi.mock('@/src/lib/pay/checkout', () => ({ taxLineItems: () => [] }));
vi.mock('@/src/lib/pay/settle-core', () => ({ settlePayment: h.settlePaymentMock }));
// #2754: which card rail the issuer has is card-rail.test.ts's concern; here it is a switch.
vi.mock('../card-rail', () => ({ resolveCardRail: h.resolveCardRailMock, resolveConnectCheckout: vi.fn() }));
vi.mock('@/src/lib/stripe/byo-checkout', () => ({
  ByoCheckoutError: class ByoCheckoutError extends Error {},
  createByoCheckoutSession: vi.fn(),
  retrieveByoCheckoutSession: vi.fn(),
}));
vi.mock('@/src/lib/chat/connection-check', () => ({ isConnected: vi.fn() }));
vi.mock('@/src/lib/connections/payment-request-invite', () => ({ createPaymentRequestInvite: vi.fn() }));
vi.mock('@/src/lib/pay/payment-requests/attestations', () => ({
  emitPaymentRequestIssuedAttestation: vi.fn(),
  emitPaymentRequestSettledAttestation: h.settledAttestationMock,
  emitPaymentRequestSettledStripeAttestation: h.settledStripeAttestationMock,
}));

import { requestEmtPayInstructions, revertEmtPending, settlePaymentRequestEmt } from '../emt';
import { settlePaymentRequestManual } from '../service';
import { settlePaymentRequestFromStripeCheckout } from '../checkout';
import { getPaymentRequestById, getPaymentRequestInvoiceByHandle, voidPaymentRequest } from '../service';

const ISSUER_DID = 'did:imajin:issuer';
const PAYER_DID = 'did:imajin:payer';
const EMT_EMAIL = 'payments@acme.example';
const HANDLE = 'ph_handle_1';
const REQUEST_ID = 'pr_0123456789abcdef01234567';
const MEMO = 'INV-0123456789';

const MANIFEST = {
  version: '0.4.0',
  // The manifest is built against the default (Stripe) rail's processor fee — which an e-Transfer must never be charged.
  fees: [{ role: 'processor', name: 'Stripe', rateBps: 370, minRateBps: 290, fixedCents: 30 }],
  chain: [{ did: ISSUER_DID, role: 'seller', share: 1 }],
  distributions: [],
  attribution: [],
  total: { amount: 5000, currency: 'CAD' },
};

async function seedRequest(overrides: { status?: string; currency?: string; allowOnPlatform?: boolean } = {}) {
  const c = h.client!;
  await c.query('DELETE FROM pay.payment_request');
  await c.query(
    `INSERT INTO pay.payment_request
       (id, kind, issuer_did, payee_account, recipient_did, line_items, currency, total_amount, subtotal_amount,
        tax_total_amount, fair_manifest, allow_on_platform, status, content_hash, pay_handle)
     VALUES ($1, 'invoice', $2, $2, $3, $4::jsonb, $5, 5000, 5000, 0, $6::jsonb, $7, $8, 'bafy-hash', $9)`,
    [
      REQUEST_ID,
      ISSUER_DID,
      PAYER_DID,
      JSON.stringify([{ name: 'Consulting', amount: 5000, quantity: 1 }]),
      overrides.currency ?? 'CAD',
      JSON.stringify(MANIFEST),
      overrides.allowOnPlatform ?? true,
      overrides.status ?? 'issued',
      HANDLE,
    ],
  );
}

async function setIssuerEmail(email: string | null) {
  const c = h.client!;
  await c.query('DELETE FROM profile.profiles WHERE did = $1', [ISSUER_DID]);
  await c.query(
    `INSERT INTO profile.profiles (did, display_name, etransfer_email) VALUES ($1, 'Acme Co', $2)`,
    [ISSUER_DID, email],
  );
}

async function rowStatus(): Promise<string> {
  const res = await h.client!.query<{ status: string }>('SELECT status FROM pay.payment_request WHERE id = $1', [REQUEST_ID]);
  return res.rows[0]!.status;
}

beforeAll(async () => {
  // Importing the mocked '@/src/db' runs the factory, which boots PGlite and replays the migrations.
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
  h.resolveCardRailMock.mockReset().mockResolvedValue({ kind: 'none' });
  await setIssuerEmail(EMT_EMAIL);
  await seedRequest();
});

const stripeInput = { paymentRequestId: REQUEST_ID, checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' };

describe('migrations 0173 / 0174', () => {
  it('the status CHECK accepts emt_pending and still rejects an unknown status', async () => {
    await expect(
      h.client!.query("UPDATE pay.payment_request SET status = 'emt_pending' WHERE id = $1", [REQUEST_ID]),
    ).resolves.toBeDefined();
    await expect(
      h.client!.query("UPDATE pay.payment_request SET status = 'bogus' WHERE id = $1", [REQUEST_ID]),
    ).rejects.toThrow(/pay_payment_request_status_check/);
  });

  it('is idempotent — re-running both migrations is a no-op', async () => {
    await h.client!.exec(readMigration('0173_pay_payment_request_emt_pending.sql'));
    await h.client!.exec(readMigration('0174_profile_etransfer_email.sql'));
    expect(await rowStatus()).toBe('issued');
  });

  it('etransfer_email defaults to NULL — a profile that never set it does not accept e-Transfer', async () => {
    await h.client!.query(`INSERT INTO profile.profiles (did, display_name) VALUES ('did:imajin:other', 'Other')`);
    const res = await h.client!.query<{ etransfer_email: string | null }>(
      `SELECT etransfer_email FROM profile.profiles WHERE did = 'did:imajin:other'`,
    );
    expect(res.rows[0]!.etransfer_email).toBeNull();
  });
});

describe('the pay page view: e-Transfer with and without the email set', () => {
  it('offers e-Transfer (without leaking the email) when the issuer set a receiving email', async () => {
    const view = await getPaymentRequestInvoiceByHandle(HANDLE);
    expect(view?.emt).toEqual({ state: 'available', instructions: null });
    expect(JSON.stringify(view)).not.toContain(EMT_EMAIL);
  });

  it('offers nothing when the issuer has no receiving email', async () => {
    await setIssuerEmail(null);
    const view = await getPaymentRequestInvoiceByHandle(HANDLE);
    expect(view?.emt).toBeNull();
  });

  it('offers nothing for a blank email, a non-CAD request, or one that disallows on-platform payment', async () => {
    await setIssuerEmail('   ');
    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.emt).toBeNull();

    await setIssuerEmail(EMT_EMAIL);
    await seedRequest({ currency: 'USD' });
    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.emt).toBeNull();

    await seedRequest({ allowOnPlatform: false });
    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.emt).toBeNull();
  });

  it('shows the instructions again to someone returning to an emt_pending request', async () => {
    await seedRequest({ status: 'emt_pending' });
    const view = await getPaymentRequestInvoiceByHandle(HANDLE);
    expect(view?.emt).toEqual({
      state: 'pending',
      instructions: { email: EMT_EMAIL, amountMinor: 5000, currency: 'CAD', memo: MEMO },
    });
  });

  it('stops offering e-Transfer once the request is settled', async () => {
    await seedRequest({ status: 'paid' });
    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.emt).toBeNull();
  });
});

describe('the pay page view: the card rail is resolved server-side (#2754)', () => {
  it('card is offered when the issuer has their own Stripe connector', async () => {
    h.resolveCardRailMock.mockResolvedValue({ kind: 'connector', ownerDid: ISSUER_DID });

    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.card).toBe(true);
    expect(h.resolveCardRailMock).toHaveBeenCalledWith(ISSUER_DID);
  });

  it('card is NOT offered when the issuer has no card rail — even though e-Transfer still is', async () => {
    const view = await getPaymentRequestInvoiceByHandle(HANDLE);

    expect(view?.card).toBe(false);
    expect(view?.emt).toEqual({ state: 'available', instructions: null });
  });

  it('neither rail: card false AND emt null (the page then says it cannot be paid online)', async () => {
    await setIssuerEmail(null);

    const view = await getPaymentRequestInvoiceByHandle(HANDLE);

    expect(view?.card).toBe(false);
    expect(view?.emt).toBeNull();
  });

  it('card is NOT offered when the request disallows on-platform payment, and the rail is not even looked up', async () => {
    h.resolveCardRailMock.mockResolvedValue({ kind: 'connector', ownerDid: ISSUER_DID });
    await seedRequest({ allowOnPlatform: false });

    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.card).toBe(false);
    expect(h.resolveCardRailMock).not.toHaveBeenCalled();
  });

  it.each(['paid', 'settled_manual'])('card is NOT offered once the request is %s, and the rail is not even looked up', async (status) => {
    h.resolveCardRailMock.mockResolvedValue({ kind: 'connector', ownerDid: ISSUER_DID });
    await seedRequest({ status });

    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.card).toBe(false);
    expect(h.resolveCardRailMock).not.toHaveBeenCalled();
  });

  it('card is still offered while the payer has chosen e-Transfer (emt_pending) — card remains a way out', async () => {
    h.resolveCardRailMock.mockResolvedValue({ kind: 'connector', ownerDid: ISSUER_DID });
    await seedRequest({ status: 'emt_pending' });

    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.card).toBe(true);
  });
});

describe('requestEmtPayInstructions — the payer chooses e-Transfer', () => {
  it('moves issued -> emt_pending and returns the email, exact amount and a request-unique memo', async () => {
    const result = await requestEmtPayInstructions(HANDLE);
    expect(result).toEqual({
      alreadyPending: false,
      instructions: { rail: 'emt', destination: EMT_EMAIL, amountMinor: 5000, currency: 'CAD', reference: MEMO },
    });
    expect(await rowStatus()).toBe('emt_pending');
  });

  it('two payers choosing e-Transfer at once both get the instructions (the loser of the guarded transition re-reads emt_pending)', async () => {
    const [a, b] = await Promise.all([requestEmtPayInstructions(HANDLE), requestEmtPayInstructions(HANDLE)]);

    expect(a).toMatchObject({ instructions: { destination: EMT_EMAIL } });
    expect(b).toMatchObject({ instructions: { destination: EMT_EMAIL } });
    expect([a, b].filter((r) => 'alreadyPending' in r && !r.alreadyPending)).toHaveLength(1);
    expect(await rowStatus()).toBe('emt_pending');
  });

  it('is idempotent — asking again returns the same instructions and changes nothing', async () => {
    await requestEmtPayInstructions(HANDLE);
    const again = await requestEmtPayInstructions(HANDLE);
    expect(again).toMatchObject({ alreadyPending: true, instructions: { destination: EMT_EMAIL, reference: MEMO } });
    expect(await rowStatus()).toBe('emt_pending');
  });

  it('404s an unknown or void handle, and 409s a settled request', async () => {
    expect(await requestEmtPayInstructions('ph_unknown')).toMatchObject({ status: 404 });

    await seedRequest({ status: 'void' });
    expect(await requestEmtPayInstructions(HANDLE)).toMatchObject({ status: 404 });

    await seedRequest({ status: 'paid' });
    expect(await requestEmtPayInstructions(HANDLE)).toMatchObject({ status: 409 });
    expect(await rowStatus()).toBe('paid');
  });

  it('400s — and does NOT move the request — when no receiving email is set', async () => {
    await setIssuerEmail(null);
    expect(await requestEmtPayInstructions(HANDLE)).toMatchObject({ status: 400 });
    expect(await rowStatus()).toBe('issued');
  });

  it('400s for a non-CAD request or one that disallows on-platform payment', async () => {
    await seedRequest({ currency: 'USD' });
    expect(await requestEmtPayInstructions(HANDLE)).toMatchObject({ status: 400 });
    await seedRequest({ allowOnPlatform: false });
    expect(await requestEmtPayInstructions(HANDLE)).toMatchObject({ status: 400 });
    expect(await rowStatus()).toBe('issued');
  });
});

describe('revertEmtPending — "Pay another way" (#2758)', () => {
  it('moves emt_pending -> issued, so a refresh no longer shows the instructions', async () => {
    await requestEmtPayInstructions(HANDLE);
    expect(await rowStatus()).toBe('emt_pending');

    const result = await revertEmtPending(HANDLE);

    expect(result).toMatchObject({ reverted: true, paymentRequest: { status: 'issued' } });
    expect(await rowStatus()).toBe('issued');
    // What the pay page renders on the next load: the e-Transfer button again, not the instructions.
    expect((await getPaymentRequestInvoiceByHandle(HANDLE))?.emt).toEqual({ state: 'available', instructions: null });
  });

  it('choosing e-Transfer again returns the SAME memo and amount', async () => {
    const first = await requestEmtPayInstructions(HANDLE);
    await revertEmtPending(HANDLE);
    const second = await requestEmtPayInstructions(HANDLE);

    expect(second).toMatchObject({ alreadyPending: false });
    expect('instructions' in first && 'instructions' in second && second.instructions).toEqual(
      'instructions' in first ? first.instructions : null,
    );
    expect(await rowStatus()).toBe('emt_pending');
  });

  it('is idempotent: reverting an already-issued request is a clean no-op', async () => {
    const result = await revertEmtPending(HANDLE);

    expect(result).toMatchObject({ reverted: false, paymentRequest: { status: 'issued' } });
    expect(await rowStatus()).toBe('issued');
  });

  it('two concurrent reverts both succeed; exactly one performs the transition', async () => {
    await requestEmtPayInstructions(HANDLE);

    const results = await Promise.all([revertEmtPending(HANDLE), revertEmtPending(HANDLE)]);

    expect(results.every((r) => 'reverted' in r)).toBe(true);
    expect(results.filter((r) => 'reverted' in r && r.reverted)).toHaveLength(1);
    expect(await rowStatus()).toBe('issued');
  });

  it.each(['paid', 'settled_manual'])('409s — and changes nothing — once a payment has been confirmed (%s)', async (status) => {
    await seedRequest({ status });

    expect(await revertEmtPending(HANDLE)).toMatchObject({ status: 409 });
    expect(await rowStatus()).toBe(status);
  });

  it('can never undo the issuer\'s confirmation: after Mark paid (e-Transfer) the revert is refused and the request stays paid', async () => {
    await requestEmtPayInstructions(HANDLE);
    await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });

    expect(await revertEmtPending(HANDLE)).toMatchObject({ status: 409 });

    const row = await getPaymentRequestById(REQUEST_ID);
    expect(row?.status).toBe('paid');
    expect(row?.settlementRef).toMatchObject({ method: 'emt' });
    expect(h.settlePaymentMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to revert a row that already carries a settlement ref, even if its status somehow reads emt_pending', async () => {
    await requestEmtPayInstructions(HANDLE);
    await h.client!.query(`UPDATE pay.payment_request SET settlement_ref = '{"method":"emt"}'::jsonb WHERE id = $1`, [REQUEST_ID]);

    expect(await revertEmtPending(HANDLE)).toMatchObject({ status: 409 });
    expect(await rowStatus()).toBe('emt_pending');
  });

  it('404s an unknown or void handle', async () => {
    expect(await revertEmtPending('ph_unknown')).toMatchObject({ status: 404 });

    await seedRequest({ status: 'void' });
    expect(await revertEmtPending(HANDLE)).toMatchObject({ status: 404 });
  });

  it('the issuer\'s confirm path is unchanged: a reverted request can still be marked paid manually if the transfer arrives anyway', async () => {
    await requestEmtPayInstructions(HANDLE);
    await revertEmtPending(HANDLE);

    // Mark paid (e-Transfer) is only valid from emt_pending...
    expect(await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID })).toMatchObject({ status: 409 });
    // ...and the existing manual settle (valid from issued) takes it from here.
    const manual = await settlePaymentRequestManual({ id: REQUEST_ID, callerDid: ISSUER_DID, note: 'e-Transfer arrived' });
    expect(manual).toMatchObject({ status: 'settled_manual' });
  });

  it('a payer who reverts can still pay by card: the request is open for a Stripe settlement', async () => {
    await requestEmtPayInstructions(HANDLE);
    await revertEmtPending(HANDLE);

    expect(await settlePaymentRequestFromStripeCheckout(stripeInput)).toMatchObject({ settled: true });
    expect(await rowStatus()).toBe('paid');
  });
});

describe('settlePaymentRequestEmt — Mark paid (e-Transfer)', () => {
  beforeEach(async () => {
    await requestEmtPayInstructions(HANDLE);
  });

  it('settles: paid status, e-Transfer settlement ref, ledger settled ONCE with NO processor fee', async () => {
    const result = await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });
    expect(result).toMatchObject({ settled: true, paymentRequest: { status: 'paid' } });

    const row = await getPaymentRequestById(REQUEST_ID);
    expect(row?.status).toBe('paid');
    expect(row?.settlementRef).toMatchObject({ method: 'emt', asserted_by: ISSUER_DID, reference: MEMO });
    expect((row?.settlementRef as { settled_at?: string }).settled_at).toBeTruthy();

    expect(h.settlePaymentMock).toHaveBeenCalledTimes(1);
    const call = h.settlePaymentMock.mock.calls[0]![0];
    expect(call).toMatchObject({
      funded: true,
      funded_provider: 'emt',
      from_did: PAYER_DID, // recorded through the single payer seam — exactly as the card path does
      currency: 'CAD',
      metadata: { payment_request_id: REQUEST_ID },
    });
    // $50.00 in, $50.00 out: the seller's share is the whole amount — no Stripe 3.7% + 30c skimmed.
    expect(call.total_amount).toBe(50);
    expect(call.fair_manifest.chain).toEqual([{ did: ISSUER_DID, role: 'seller', amount: 50 }]);
  });

  it('attests the settlement naming the rail (issuer-signed, with the memo) and notifies via payment_request.settled', async () => {
    await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });

    expect(h.settledAttestationMock).toHaveBeenCalledTimes(1);
    expect(h.settledAttestationMock.mock.calls[0]![0]).toMatchObject({
      paymentRequestId: REQUEST_ID,
      issuerDid: ISSUER_DID,
      recipientDid: PAYER_DID,
      method: 'emt',
      assertedBy: ISSUER_DID,
      reference: MEMO,
      totalAmount: 5000,
      currency: 'CAD',
    });
    expect(h.settledStripeAttestationMock).not.toHaveBeenCalled();

    const settled = h.publishMock.mock.calls.filter(([type]) => type === 'payment_request.settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]![1]).toMatchObject({
      issuer: ISSUER_DID,
      subject: PAYER_DID, // the payer — the notify reactor tells them
      payload: { paymentRequestId: REQUEST_ID, method: 'emt', attestationId: 'att_emt_1' },
    });
  });

  it('the card path on the same manifest DOES deduct the Stripe fee (so the no-fee EMT result is the rail, not the fixture)', async () => {
    await settlePaymentRequestFromStripeCheckout(stripeInput);
    const call = h.settlePaymentMock.mock.calls[0]![0];
    expect(call.funded_provider).toBe('stripe');
    expect(call.total_amount).toBeCloseTo(50 - (50 * 0.037 + 0.3), 2);
  });

  it('is idempotent: a replay is a clean no-op that never touches the ledger again', async () => {
    await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });
    const replay = await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });

    expect(replay).toMatchObject({ settled: false, paymentRequest: { status: 'paid' } });
    expect(h.settlePaymentMock).toHaveBeenCalledTimes(1);
    expect(h.settledAttestationMock).toHaveBeenCalledTimes(1);
  });

  it('two concurrent mark-paid clicks settle exactly once', async () => {
    const results = await Promise.all([
      settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID }),
      settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID }),
    ]);
    expect(results.filter((r) => 'settled' in r && r.settled)).toHaveLength(1);
    expect(results.every((r) => 'settled' in r)).toBe(true);
    expect(h.settlePaymentMock).toHaveBeenCalledTimes(1);
  });

  it('a failing bus publish never un-settles the payment — the settlement stands and the call still succeeds', async () => {
    h.publishMock.mockRejectedValue(new Error('bus down'));
    const result = await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });

    expect(result).toMatchObject({ settled: true });
    expect(await rowStatus()).toBe('paid');
  });

  it('refuses a request that is not emt_pending (409) — it must be chosen by the payer first', async () => {
    await seedRequest({ status: 'issued' });
    expect(await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID })).toMatchObject({ status: 409 });
    expect(await rowStatus()).toBe('issued');
    expect(h.settlePaymentMock).not.toHaveBeenCalled();
  });

  it('404s an unknown request', async () => {
    expect(await settlePaymentRequestEmt({ id: 'pr_missing', callerDid: ISSUER_DID })).toMatchObject({ status: 404 });
  });

  it('alerts the operator and answers 422 when the ledger settlement fails after the money was confirmed', async () => {
    h.settlePaymentMock.mockResolvedValue({ error: 'ledger said no', status: 400 });
    const result = await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });

    expect(result).toMatchObject({ status: 422 });
    const alert = h.publishMock.mock.calls.find(([type]) => type === 'payment_request.settlement_failed');
    expect(alert?.[1]).toMatchObject({ payload: { paymentRequestId: REQUEST_ID, reason: 'settle_rejected', method: 'emt' } });
    expect(h.settledAttestationMock).not.toHaveBeenCalled();
  });
});

describe('issuer authorization on mark-paid (enforced server-side)', () => {
  beforeEach(async () => {
    await requestEmtPayInstructions(HANDLE);
  });

  it('refuses an unauthorized caller with 403 — and settles nothing', async () => {
    const result = await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: 'did:imajin:stranger' });

    expect(result).toMatchObject({ status: 403 });
    expect(await rowStatus()).toBe('emt_pending');
    expect(h.settlePaymentMock).not.toHaveBeenCalled();
    expect(h.settledAttestationMock).not.toHaveBeenCalled();
    expect(h.publishMock).not.toHaveBeenCalled();
  });

  it('refuses the PAYER too — the recipient cannot confirm their own payment', async () => {
    const result = await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: PAYER_DID });

    expect(result).toMatchObject({ status: 403 });
    expect(await rowStatus()).toBe('emt_pending');
    expect(h.settlePaymentMock).not.toHaveBeenCalled();
  });

  it('allows the issuer business when it is the resolved acting DID (someone acting for the issuer)', async () => {
    // `resolveActingDid` hands the service the business DID when a delegate acts for it — so the caller IS the issuer here.
    const result = await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });
    expect(result).toMatchObject({ settled: true });
  });
});

describe('the double-settle guard across rails (card and e-Transfer)', () => {
  beforeEach(async () => {
    await requestEmtPayInstructions(HANDLE);
  });

  it('card settles first -> a later Mark paid (e-Transfer) is a 409, and the ledger settled once', async () => {
    await settlePaymentRequestFromStripeCheckout(stripeInput);
    expect(await rowStatus()).toBe('paid');

    const emt = await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });
    expect(emt).toMatchObject({ status: 409 });
    expect(h.settlePaymentMock).toHaveBeenCalledTimes(1);
    expect(h.settlePaymentMock.mock.calls[0]![0].funded_provider).toBe('stripe');
    expect((await getPaymentRequestById(REQUEST_ID))?.settlementRef).toMatchObject({ method: 'stripe' });
  });

  it('e-Transfer settles first -> a later card webhook is a no-op (settled: false), and the ledger settled once', async () => {
    await settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });

    const card = await settlePaymentRequestFromStripeCheckout(stripeInput);
    expect(card).toMatchObject({ settled: false });
    expect(h.settlePaymentMock).toHaveBeenCalledTimes(1);
    expect(h.settlePaymentMock.mock.calls[0]![0].funded_provider).toBe('emt');
    expect((await getPaymentRequestById(REQUEST_ID))?.settlementRef).toMatchObject({ method: 'emt' });
  });

  it('a card payment landing on an emt_pending request settles it (e-Transfer never blocks card)', async () => {
    const card = await settlePaymentRequestFromStripeCheckout(stripeInput);
    expect(card).toMatchObject({ settled: true, paymentRequest: { status: 'paid' } });
    expect(h.settlePaymentMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['emt first', 0],
    ['card first', 1],
  ])('a true race (%s in call order) lets exactly ONE rail settle', async (_label, order) => {
    const emt = () => settlePaymentRequestEmt({ id: REQUEST_ID, callerDid: ISSUER_DID });
    const card = () => settlePaymentRequestFromStripeCheckout(stripeInput);

    const [a, b] = await Promise.all(order === 0 ? [emt(), card()] : [card(), emt()]);

    expect(await rowStatus()).toBe('paid');
    expect(h.settlePaymentMock).toHaveBeenCalledTimes(1);
    expect(h.settledAttestationMock.mock.calls.length + h.settledStripeAttestationMock.mock.calls.length).toBe(1);
    const winners = [a, b].filter((r) => 'settled' in r && r.settled);
    expect(winners).toHaveLength(1);
  });

  it('the same card session replayed after settling stays a quiet no-op', async () => {
    await settlePaymentRequestFromStripeCheckout(stripeInput);
    const replay = await settlePaymentRequestFromStripeCheckout(stripeInput);
    expect(replay).toMatchObject({ settled: false });
    expect(h.settlePaymentMock).toHaveBeenCalledTimes(1);
  });
});

describe('voiding an e-Transfer-pending request', () => {
  it('the issuer can still void it — a payer choosing e-Transfer cannot lock them out', async () => {
    await requestEmtPayInstructions(HANDLE);
    const result = await voidPaymentRequest({ id: REQUEST_ID, callerDid: ISSUER_DID });
    expect(result).toMatchObject({ status: 'void' });
    expect(await rowStatus()).toBe('void');
  });
});
