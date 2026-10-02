/**
 * End-to-end (route-level) tests for the Stripe webhook's
 * `checkout.session.completed` settlement of a generic checkout whose `.fair`
 * manifest carries `taxes[]` (#2435).
 *
 * Invariant under test: tax is never fee base. Stripe's `amount_total` is the
 * GROSS charge (merchandise + tax); every chain share must be computed on the
 * pre-tax basis only, and each tax row must be booked as a trust liability —
 * not skimmed into platform/node/protocol fee shares.
 *
 * Same black-box harness as `golden-webhook-settlement.test.ts`: the real
 * route + `webhook-handlers.ts`, with only the db / bus / Stripe client mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface TxFixture {
  id: string;
  service: string;
  status: string;
  fairManifest: unknown;
}

const state = vi.hoisted(() => ({
  txRow: undefined as TxFixture | undefined,
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  idCounter: 0,
}));

function resetState() {
  state.txRow = undefined;
  state.insertCalls = [];
  state.updateCalls = [];
  state.idCounter = 0;
}

vi.mock('@/src/db', async () => {
  const { createMockDb, tableTag } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');

  const transactions = { __table: 'transactions' };
  const feeLedger = { __table: 'feeLedger' };
  const balances = { __table: 'balances' };
  const balanceRollups = { __table: 'balanceRollups' };

  function limitResultFor(table: unknown) {
    if (tableTag(table) === 'transactions') {
      return Promise.resolve(state.txRow ? [state.txRow] : []);
    }
    return Promise.resolve([]);
  }

  const { select, update, insert } = createMockDb(state, limitResultFor);

  return { db: { select, update, insert }, transactions, feeLedger, balances, balanceRollups };
});

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${state.idCounter++}`,
}));

const { constructEventMock, retrievePaymentIntentMock } = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  retrievePaymentIntentMock: vi.fn(),
}));
vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({
    webhooks: { constructEvent: constructEventMock },
    paymentIntents: { retrieve: retrievePaymentIntentMock },
  }),
}));

// The payment_request-linked branch is covered by `payment-request-checkout.test.ts`;
// mocked so its transitive node-identity import never needs a DATABASE_URL.
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({
  settlePaymentRequestFromStripeCheckout: vi.fn(),
}));

import { POST } from '../route';

type NextRequestLike = Parameters<typeof POST>[0];

const SELLER_DID = 'did:imajin:seller';
const NODE_DID = 'did:imajin:node';
const BUYER_DID = 'did:imajin:buyer';
const CRA_DID = 'did:imajin:authority:ca-cra';

const BASIS_CENTS = 10_000;
const TAX_CENTS = 1300; // 13% GST/HST on the basis
const GROSS_CENTS = BASIS_CENTS + TAX_CENTS;

function makeRequest(): NextRequestLike {
  return new Request('http://localhost:3000/pay/api/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: 'raw-body',
  }) as unknown as NextRequestLike;
}

function makeCheckoutEvent(session: Record<string, unknown>) {
  return {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test', amount_total: GROSS_CENTS, currency: 'cad', payment_intent: null, metadata: {}, ...session } },
  };
}

function gstRow(overrides: Record<string, unknown> = {}) {
  return {
    jurisdiction: 'CA-ON',
    kind: 'GST/HST',
    rateBps: 1300,
    basisAmount: BASIS_CENTS,
    amount: TAX_CENTS,
    collectorDid: SELLER_DID,
    remitTo: CRA_DID,
    registrationNumber: '123456789RT0001',
    ...overrides,
  };
}

function taxedManifest(extra: Record<string, unknown> = {}) {
  return {
    fair: '1.2',
    chain: [
      { did: SELLER_DID, role: 'seller', share: 0.95 },
      { did: NODE_DID, role: 'node', share: 0.03 },
      { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.02 },
    ],
    taxes: [gstRow()],
    ...extra,
  };
}

function inserts(table: string) {
  return state.insertCalls.filter((c) => c.table === table);
}

async function settle(manifest: unknown, session: Record<string, unknown> = {}) {
  state.txRow = { id: 'tx_fixture', service: 'market', status: 'pending', fairManifest: manifest };
  constructEventMock.mockReturnValue(
    makeCheckoutEvent({ metadata: { service: 'market_test', buyerDid: BUYER_DID }, ...session }),
  );
  const res = await POST(makeRequest());
  expect(res.status).toBe(200);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.PLATFORM_DID = 'did:imajin:platform';
  retrievePaymentIntentMock.mockResolvedValue({ latest_charge: null });
});

describe('Webhook checkout.session.completed with .fair taxes[] (#2435)', () => {
  it('computes every chain share on the pre-tax basis, never on the gross Stripe total', async () => {
    await settle(taxedManifest());

    const byRole = Object.fromEntries(
      inserts('feeLedger')
        .filter((c) => ['seller', 'node', 'buyer_credit'].includes(c.values.role as string))
        .map((c) => [c.values.role, c.values]),
    );
    expect(byRole.seller).toMatchObject({ amountCents: 9500, status: 'paid_out' }); // 95% of 10000, not 10735
    expect(byRole.node).toMatchObject({ amountCents: 300, status: 'accrued' }); // 3% of 10000, not 339
    expect(byRole.buyer_credit).toMatchObject({ amountCents: 200, recipientDid: BUYER_DID, status: 'accrued' });

    // Σ chain shares == basis exactly: not one cent of tax entered the fee base.
    const chainTotal = Object.values(byRole).reduce((sum, row) => sum + (row.amountCents as number), 0);
    expect(chainTotal).toBe(BASIS_CENTS);
  });

  it('credits node and buyer_credit balances from basis-derived amounts only', async () => {
    await settle(taxedManifest());

    const balanceInserts = inserts('balances');
    expect(balanceInserts).toHaveLength(2); // node (MJN) + buyer_credit (MJNx); seller + tax never credited internally
    expect(balanceInserts.find((c) => c.values.did === NODE_DID)!.values).toMatchObject({ unit: 'MJN', amount: '3.00000000' });
    expect(balanceInserts.find((c) => c.values.did === BUYER_DID)!.values).toMatchObject({ unit: 'MJNx', amount: '2.00000000' });
    expect(balanceInserts.some((c) => c.values.did === SELLER_DID)).toBe(false);
  });

  it('credits the tax as a trust liability: a held_in_trust fee-ledger row for the collector, full amount', async () => {
    await settle(taxedManifest());

    const taxRows = inserts('feeLedger').filter((c) => c.values.role === 'tax');
    expect(taxRows).toHaveLength(1);
    expect(taxRows[0].values).toMatchObject({
      transactionId: 'tx_fixture',
      recipientDid: SELLER_DID,
      amountCents: TAX_CENTS,
      currency: 'CAD',
      status: 'held_in_trust',
    });
  });

  it('writes the tax ledger transactions row in the shape the remittance-owed report reads', async () => {
    await settle(taxedManifest());

    const taxTx = inserts('transactions').find((c) => c.values.type === 'tax');
    expect(taxTx).toBeDefined();
    expect(taxTx!.values).toMatchObject({
      toDid: SELLER_DID,
      fromDid: BUYER_DID,
      amount: '13.00',
      currency: 'CAD',
      unit: 'MJN',
      status: 'completed',
    });
    // Must never carry the checkout session id: the webhook's idempotency lookup keys on it.
    expect(taxTx!.values.stripeId).toBeUndefined();
    expect(taxTx!.values.metadata).toMatchObject({
      tax: true,
      jurisdiction: 'CA-ON',
      kind: 'GST/HST',
      rateBps: 1300,
      remitTo: CRA_DID,
      registrationNumber: '123456789RT0001',
      trustLiability: true,
      remitted: null,
      checkoutTransactionId: 'tx_fixture',
    });
  });

  it('keeps the processor-fee estimate on the GROSS charge (the seller absorbs Stripe\'s fee on the tax)', async () => {
    await settle(taxedManifest());

    const processor = inserts('feeLedger').find((c) => c.values.recipientDid === 'stripe:processor')!;
    // fallback 3.7% + 30c of the gross 11300 = 418 + 30
    expect(processor.values).toMatchObject({ role: 'processor', amountCents: 448 });
  });

  it('settles each row of a multi-jurisdiction taxes[] and still splits only the basis', async () => {
    const qst = gstRow({ jurisdiction: 'CA-QC', kind: 'QST', rateBps: 998, amount: 998, registrationNumber: '1234567890TQ0001' });
    const gst = gstRow({ jurisdiction: 'CA-QC', kind: 'GST/HST', rateBps: 500, amount: 500 });
    await settle(taxedManifest({ taxes: [gst, qst] }), { amount_total: BASIS_CENTS + 500 + 998 });

    const taxRows = inserts('feeLedger').filter((c) => c.values.role === 'tax');
    expect(taxRows.map((c) => c.values.amountCents)).toEqual([500, 998]);
    expect(inserts('transactions').filter((c) => c.values.type === 'tax')).toHaveLength(2);

    const node = inserts('feeLedger').find((c) => c.values.role === 'node')!;
    expect(node.values.amountCents).toBe(300);
  });

  it('skips a zero-amount tax row (nothing was charged for it)', async () => {
    await settle(taxedManifest({ taxes: [gstRow({ rateBps: 0, amount: 0 })] }), { amount_total: BASIS_CENTS });

    expect(inserts('feeLedger').some((c) => c.values.role === 'tax')).toBe(false);
    expect(inserts('transactions').some((c) => c.values.type === 'tax')).toBe(false);
    expect(inserts('feeLedger').find((c) => c.values.role === 'node')!.values.amountCents).toBe(300);
  });

  it('fails closed — no chain or tax ledger rows — when the Stripe total does not exceed the claimed tax', async () => {
    await settle(taxedManifest(), { amount_total: TAX_CENTS });

    expect(inserts('feeLedger').some((c) => ['seller', 'node', 'buyer_credit', 'tax'].includes(c.values.role as string))).toBe(false);
    expect(inserts('transactions')).toHaveLength(0);
    expect(inserts('balances')).toHaveLength(0);
  });

  it('is unchanged for a manifest without taxes[] (fee shares on the full Stripe total)', async () => {
    await settle(
      { chain: [{ did: SELLER_DID, role: 'seller', share: 0.97 }, { did: NODE_DID, role: 'node', share: 0.03 }] },
      { amount_total: BASIS_CENTS },
    );

    expect(inserts('feeLedger').find((c) => c.values.role === 'node')!.values.amountCents).toBe(300);
    expect(inserts('feeLedger').some((c) => c.values.role === 'tax')).toBe(false);
    expect(inserts('transactions')).toHaveLength(0);
  });
});
