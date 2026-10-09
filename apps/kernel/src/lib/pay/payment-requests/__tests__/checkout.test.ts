/**
 * Tests for `pay.payment_request` <-> Stripe Checkout linkage (#2209):
 * session creation/reuse (`createPaymentRequestCheckoutSession`) and the
 * webhook-side settle (`settlePaymentRequestFromStripeCheckout`).
 *
 * `@imajin/fair`'s `resolveSettlementChain` runs for REAL (pure,
 * deterministic) — only DB, Stripe, the generic checkout lib, settle-core,
 * the attestation emitter, and the bus are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  getPaymentRequestByIdMock: vi.fn(),
  resolveConnectedAccountFeeMock: vi.fn(),
  resolveCardRailMock: vi.fn(),
  createByoSessionMock: vi.fn(),
  retrieveByoSessionMock: vi.fn(),
  payCheckoutMock: vi.fn(),
  stripeSessionsRetrieveMock: vi.fn(),
  settlePaymentMock: vi.fn(),
  settledStripeAttestationMock: vi.fn().mockResolvedValue('att_settled_stripe_1'),
  settledAttestationMock: vi.fn().mockResolvedValue('att_settled_emt_1'),
  publishMock: vi.fn().mockResolvedValue(undefined),
  getNodeDidMock: vi.fn().mockResolvedValue('did:imajin:node'),
  insertCalls: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<{ values: Record<string, unknown> }>,
  updateReturningQueue: [] as Array<Record<string, unknown>[]>,
  selectTxQueue: [] as Array<Record<string, unknown>[]>,
}));

function resetState() {
  for (const value of Object.values(state)) {
    if (Array.isArray(value)) value.length = 0;
  }
  state.getPaymentRequestByIdMock.mockReset();
  state.resolveConnectedAccountFeeMock.mockReset();
  state.resolveCardRailMock.mockReset();
  state.createByoSessionMock.mockReset();
  state.retrieveByoSessionMock.mockReset();
  state.payCheckoutMock.mockReset();
  state.stripeSessionsRetrieveMock.mockReset();
  state.settlePaymentMock.mockReset();
  state.settledStripeAttestationMock.mockReset().mockResolvedValue('att_settled_stripe_1');
  state.settledAttestationMock.mockReset().mockResolvedValue('att_settled_emt_1');
  state.publishMock.mockReset().mockResolvedValue(undefined);
  state.getNodeDidMock.mockReset().mockResolvedValue('did:imajin:node');
}

function selectTxResult() {
  return Promise.resolve(state.selectTxQueue.shift() ?? []);
}
function orderByResult() {
  return { limit: selectTxResult };
}
function selectWhereResult() {
  // `.orderBy().limit()` for the reusable-session lookup; bare `.limit()` for the retry's ledger-rows lookup (#2439).
  return { orderBy: orderByResult, limit: selectTxResult };
}
function selectFromResult() {
  return { where: selectWhereResult };
}

function updateReturning() {
  return Promise.resolve(state.updateReturningQueue.shift() ?? []);
}
function updateWhere(values: Record<string, unknown>) {
  state.updateCalls.push({ values });
  return { returning: updateReturning };
}
function updateSetResult(values: Record<string, unknown>) {
  return { where: () => updateWhere(values) };
}

function insertValues(values: Record<string, unknown>) {
  state.insertCalls.push(values);
  return Promise.resolve(undefined);
}

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: selectFromResult }),
    insert: () => ({ values: insertValues }),
    update: () => ({ set: updateSetResult }),
  },
  paymentRequests: { __table: 'payment_request', id: 'id', status: 'status' },
  transactions: { __table: 'transactions', id: 'id', service: 'service', type: 'type', metadata: 'metadata', status: 'status', createdAt: 'createdAt', externalRef: 'externalRef', rail: 'rail' },
}));

vi.mock('@imajin/bus', () => ({ publish: state.publishMock }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: state.getNodeDidMock }));
vi.mock('@imajin/config', () => ({ buildPublicUrlAbsolute: (name: string) => `https://kernel.test/${name}` }));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: () => ({ checkout: state.payCheckoutMock }) }));
vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ checkout: { sessions: { retrieve: state.stripeSessionsRetrieveMock } } }),
}));
vi.mock('@/src/lib/pay/checkout', () => ({
  resolveConnectedAccountFee: state.resolveConnectedAccountFeeMock,
  // #2419: real (pure) implementation — [] for every manifest in this
  // suite's fixtures, since none carry `taxes[]`.
  taxLineItems: (fairManifest: { taxes?: Array<{ jurisdiction: string; kind: string; amount: number }> }) =>
    (fairManifest?.taxes ?? []).map((tax) => ({
      name: `${tax.kind} (${tax.jurisdiction})`,
      description: 'Sales tax collected in trust',
      amount: tax.amount,
      quantity: 1,
    })),
}));
// #2754: rail selection and the issuer-key Stripe calls are their own suites' business.
vi.mock('../card-rail', () => ({
  resolveCardRail: state.resolveCardRailMock,
  resolveConnectCheckout: (body: unknown) => state.resolveConnectedAccountFeeMock(body),
}));
vi.mock('@/src/lib/stripe/byo-checkout', () => {
  class ByoCheckoutError extends Error {
    readonly code: string;
    readonly stripeStatus: number | undefined;
    constructor(code: string, message: string, stripeStatus?: number) {
      super(message);
      this.code = code;
      this.stripeStatus = stripeStatus;
    }
  }
  return {
    ByoCheckoutError,
    createByoCheckoutSession: state.createByoSessionMock,
    retrieveByoCheckoutSession: state.retrieveByoSessionMock,
  };
});
vi.mock('@/src/lib/pay/settle-core', () => ({ settlePayment: state.settlePaymentMock }));
vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  getPaymentRequestById: state.getPaymentRequestByIdMock,
  // #2656: checkout also resolves the opaque pay-link handle when the id lookup misses.
  findLiveRowByHandle: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/src/lib/pay/payment-requests/attestations', () => ({
  emitPaymentRequestSettledStripeAttestation: state.settledStripeAttestationMock,
  // #2665: the e-Transfer settlement is issuer-signed (`emt-announce.ts`).
  emitPaymentRequestSettledAttestation: state.settledAttestationMock,
}));

import { ByoCheckoutError } from '@/src/lib/stripe/byo-checkout';
import {
  createPaymentRequestCheckoutSession,
  retryPaymentRequestStripeSettlement,
  settlePaymentRequestFromStripeCheckout,
} from '../checkout';

const ISSUER_DID = 'did:imajin:issuer';
const RECIPIENT_DID = 'did:imajin:recipient';

const ISSUED_REQUEST = {
  id: 'pr_1',
  issuerDid: ISSUER_DID,
  recipientDid: RECIPIENT_DID,
  status: 'issued',
  allowOnPlatform: true,
  currency: 'CAD',
  totalAmount: 5000,
  subtotalAmount: 5000,
  taxTotalAmount: 0,
  contentHash: 'bafy-x',
  lineItems: [{ name: 'Consulting', amount: 5000, quantity: 1 }],
  fairManifest: {
    version: '0.4.0',
    fees: [],
    chain: [{ did: ISSUER_DID, role: 'seller', share: 1 }],
    distributions: [],
    attribution: [],
    total: { amount: 5000, currency: 'CAD' },
  },
};

beforeEach(() => {
  resetState();
  // The pre-#2754 suite below exercises the Connect fallback; the connector rail has its own describe.
  state.resolveCardRailMock.mockResolvedValue({ kind: 'connect' });
  state.resolveConnectedAccountFeeMock.mockResolvedValue({
    ok: true,
    connectedAccountId: 'acct_123',
    applicationFeeAmount: 200,
  });
  state.payCheckoutMock.mockResolvedValue({
    id: 'cs_new',
    url: 'https://checkout.stripe.com/cs_new',
    expiresAt: new Date('2026-01-01T01:00:00Z'),
  });
});

describe('createPaymentRequestCheckoutSession', () => {
  it('returns 404 when the payment_request does not exist', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(null);
    const result = await createPaymentRequestCheckoutSession({ id: 'pr_missing', callerDid: ISSUER_DID });
    expect(result).toMatchObject({ status: 404 });
  });

  it('returns 403 when the caller is neither the issuer nor the recipient', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: 'did:imajin:stranger' });
    expect(result).toMatchObject({ status: 403 });
  });

  it('returns 409 when the request is not in issued status', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue({ ...ISSUED_REQUEST, status: 'paid' });
    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(result).toMatchObject({ status: 409 });
    expect(state.payCheckoutMock).not.toHaveBeenCalled();
  });

  it('#2665: a request the payer chose to pay by e-Transfer (emt_pending) can still be paid by card', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue({ ...ISSUED_REQUEST, status: 'emt_pending' });
    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(result).toMatchObject({ id: 'cs_new', reused: false });
    expect(state.payCheckoutMock).toHaveBeenCalled();
  });

  it('returns 400 when allow_on_platform is false', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue({ ...ISSUED_REQUEST, allowOnPlatform: false });
    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(result).toMatchObject({ status: 400 });
    expect(state.payCheckoutMock).not.toHaveBeenCalled();
  });

  it('propagates a fee-resolution error (e.g. seller not connected)', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    state.resolveConnectedAccountFeeMock.mockResolvedValue({
      ok: false,
      error: "Seller hasn't completed payment setup",
      status: 400,
    });
    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(result).toMatchObject({ status: 400 });
    expect(state.payCheckoutMock).not.toHaveBeenCalled();
  });

  it('the recipient may also create a checkout session', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: RECIPIENT_DID });
    expect(result).toMatchObject({ id: 'cs_new', reused: false });
  });

  it('creates a new session composing sellerDid/connectedAccountId/fairManifest/metadata, and records a pending tx without a fairManifest column', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    const result = await createPaymentRequestCheckoutSession({
      id: 'pr_1',
      callerDid: ISSUER_DID,
      customerEmail: 'buyer@example.com',
    });

    expect(result).toMatchObject({ id: 'cs_new', url: 'https://checkout.stripe.com/cs_new', reused: false });

    expect(state.resolveConnectedAccountFeeMock).toHaveBeenCalledWith(
      expect.objectContaining({ sellerDid: ISSUER_DID, fairManifest: ISSUED_REQUEST.fairManifest }),
    );

    expect(state.payCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'CAD',
        customerEmail: 'buyer@example.com',
        connectedAccountId: 'acct_123',
        applicationFeeAmount: 200,
        metadata: expect.objectContaining({ payment_request_id: 'pr_1' }),
      }),
    );

    expect(state.insertCalls).toHaveLength(1);
    const inserted = state.insertCalls[0];
    // #2176/#2650: `external_ref` + `rail` are set; the dropped `stripe_id` column is never written.
    expect(inserted.externalRef).toBe('cs_new');
    expect(inserted.rail).toBe('stripe');
    expect(inserted).not.toHaveProperty('stripeId');
    expect(inserted.status).toBe('pending');
    expect(inserted.fairManifest).toBeUndefined();
    expect((inserted.metadata as Record<string, string>).payment_request_id).toBe('pr_1');
  });

  describe('with tax (#2421)', () => {
    const TAXED_REQUEST = {
      ...ISSUED_REQUEST,
      lineItems: [{ name: 'Consulting', amount: 5000, quantity: 2 }],
      subtotalAmount: 10_000,
      taxTotalAmount: 1300,
      totalAmount: 11_300,
      fairManifest: {
        ...ISSUED_REQUEST.fairManifest,
        fair: '1.2',
        total: { amount: 10_000, currency: 'CAD' },
        taxes: [
          {
            jurisdiction: 'CA-ON',
            kind: 'GST/HST',
            rateBps: 1300,
            basisAmount: 10_000,
            amount: 1300,
            registrationNumber: '123456789RT0001',
            collectorDid: ISSUER_DID,
            remitTo: 'did:imajin:authority:ca-cra',
          },
        ],
      },
    };

    it('sends tax as its own Stripe line item, after the untouched merchandise items', async () => {
      state.getPaymentRequestByIdMock.mockResolvedValue(TAXED_REQUEST);
      await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

      const checkoutArgs = state.payCheckoutMock.mock.calls[0][0];
      expect(checkoutArgs.items).toEqual([
        { name: 'Consulting', amount: 5000, quantity: 2 },
        { name: 'GST/HST (CA-ON)', description: 'Sales tax collected in trust', amount: 1300, quantity: 1 },
      ]);
      // Stripe's grand total == the row's total_amount (subtotal + tax), exactly.
      const stripeTotal = checkoutArgs.items.reduce((sum: number, i: { amount: number; quantity: number }) => sum + i.amount * i.quantity, 0);
      expect(stripeTotal).toBe(TAXED_REQUEST.totalAmount);
    });

    it('computes the fee on the merchandise-only (pre-tax) items, never on the tax line', async () => {
      state.getPaymentRequestByIdMock.mockResolvedValue(TAXED_REQUEST);
      await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

      const feeArgs = state.resolveConnectedAccountFeeMock.mock.calls[0][0];
      expect(feeArgs.items).toEqual([{ name: 'Consulting', amount: 5000, quantity: 2 }]);
      expect(feeArgs.items.some((i: { name: string }) => i.name.startsWith('GST/HST'))).toBe(false);
      expect(feeArgs.fairManifest.taxes).toHaveLength(1);
    });

    it('records the pending tx at the grand total (subtotal + tax)', async () => {
      state.getPaymentRequestByIdMock.mockResolvedValue(TAXED_REQUEST);
      await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });
      expect(state.insertCalls[0].amount).toBe('113');
    });

    it('refuses (409) when the line items no longer sum to subtotal_amount', async () => {
      state.getPaymentRequestByIdMock.mockResolvedValue({ ...TAXED_REQUEST, subtotalAmount: 9_999 });
      const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });
      expect(result).toMatchObject({ status: 409 });
      expect(state.payCheckoutMock).not.toHaveBeenCalled();
    });

    it('a request without tax sends exactly its line items and nothing else', async () => {
      state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
      await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });
      expect(state.payCheckoutMock.mock.calls[0][0].items).toEqual([{ name: 'Consulting', amount: 5000, quantity: 1 }]);
    });
  });

  it('reuses an existing open Stripe session instead of creating a duplicate', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    state.selectTxQueue.push([{ externalRef: 'cs_existing' }]);
    state.stripeSessionsRetrieveMock.mockResolvedValue({
      id: 'cs_existing',
      url: 'https://checkout.stripe.com/cs_existing',
      status: 'open',
      expires_at: Math.floor(new Date('2026-01-01T02:00:00Z').getTime() / 1000),
    });

    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(result).toMatchObject({ id: 'cs_existing', url: 'https://checkout.stripe.com/cs_existing', reused: true });
    expect(state.payCheckoutMock).not.toHaveBeenCalled();
    expect(state.insertCalls).toHaveLength(0);
  });

  it('creates a fresh session when the existing Stripe session is no longer open', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    state.selectTxQueue.push([{ externalRef: 'cs_expired' }]);
    state.stripeSessionsRetrieveMock.mockResolvedValue({ id: 'cs_expired', status: 'expired' });

    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(result).toMatchObject({ id: 'cs_new', reused: false });
    expect(state.payCheckoutMock).toHaveBeenCalledOnce();
  });
});

describe('createPaymentRequestCheckoutSession — rail selection (#2754)', () => {
  const CONNECTOR_RAIL = { kind: 'connector', ownerDid: ISSUER_DID };
  const HANDLED_REQUEST = { ...ISSUED_REQUEST, payHandle: 'ph_abc' };
  const BYO_SESSION = { id: 'cs_byo', url: 'https://checkout.stripe.com/cs_byo', expiresAt: new Date('2026-01-02T00:00:00Z') };

  it('charges on the issuer\'s own account when they have a connector: no Connect fee lookup, no platform session', async () => {
    state.resolveCardRailMock.mockResolvedValue(CONNECTOR_RAIL);
    state.getPaymentRequestByIdMock.mockResolvedValue(HANDLED_REQUEST);
    state.createByoSessionMock.mockResolvedValue(BYO_SESSION);

    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: RECIPIENT_DID, customerEmail: 'b@example.com' });

    expect(result).toMatchObject({ id: 'cs_byo', url: BYO_SESSION.url, reused: false });
    expect(state.resolveCardRailMock).toHaveBeenCalledWith(ISSUER_DID);
    expect(state.payCheckoutMock).not.toHaveBeenCalled();
    expect(state.resolveConnectedAccountFeeMock).not.toHaveBeenCalled();

    const [ownerDid, input] = state.createByoSessionMock.mock.calls[0];
    expect(ownerDid).toBe(ISSUER_DID);
    expect(input).toMatchObject({
      currency: 'CAD',
      customerEmail: 'b@example.com',
      items: [{ name: 'Consulting', amount: 5000, quantity: 1 }],
      metadata: {
        payment_request_id: 'pr_1',
        paymentRequestId: 'pr_1',
        payHandle: 'ph_abc',
        service: 'payment_request',
        type: 'payment_request_checkout',
      },
    });
    // The payer returns to the pay page itself, which becomes the receipt.
    expect(input.successUrl).toBe('https://kernel.test/pay/r/ph_abc');
    expect(input.cancelUrl).toBe('https://kernel.test/pay/r/ph_abc');
  });

  it('records the pending transaction on the BYO rail with the session as its external_ref', async () => {
    state.resolveCardRailMock.mockResolvedValue(CONNECTOR_RAIL);
    state.getPaymentRequestByIdMock.mockResolvedValue(HANDLED_REQUEST);
    state.createByoSessionMock.mockResolvedValue(BYO_SESSION);

    await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(state.insertCalls).toHaveLength(1);
    expect(state.insertCalls[0]).toMatchObject({ rail: 'stripe-byo', externalRef: 'cs_byo', status: 'pending', toDid: ISSUER_DID });
  });

  it('sends tax as its own line item on the issuer\'s account, exactly as the Connect path does', async () => {
    state.resolveCardRailMock.mockResolvedValue(CONNECTOR_RAIL);
    state.getPaymentRequestByIdMock.mockResolvedValue({
      ...HANDLED_REQUEST,
      subtotalAmount: 5000,
      totalAmount: 5650,
      fairManifest: {
        ...ISSUED_REQUEST.fairManifest,
        taxes: [{ jurisdiction: 'CA-ON', kind: 'HST', rateBps: 1300, basisAmount: 5000, amount: 650, collectorDid: ISSUER_DID }],
      },
    });
    state.createByoSessionMock.mockResolvedValue(BYO_SESSION);

    await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(state.createByoSessionMock.mock.calls[0][1].items).toEqual([
      { name: 'Consulting', amount: 5000, quantity: 1 },
      { name: 'HST (CA-ON)', description: 'Sales tax collected in trust', amount: 650, quantity: 1 },
    ]);
  });

  it('refuses with a 400 SELLER_NOT_CONNECTED code — and creates nothing anywhere — when the issuer has no card rail', async () => {
    state.resolveCardRailMock.mockResolvedValue({ kind: 'none' });
    state.getPaymentRequestByIdMock.mockResolvedValue(HANDLED_REQUEST);

    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(result).toMatchObject({ status: 400, code: 'SELLER_NOT_CONNECTED' });
    expect(state.createByoSessionMock).not.toHaveBeenCalled();
    expect(state.payCheckoutMock).not.toHaveBeenCalled();
    expect(state.insertCalls).toHaveLength(0);
  });

  it.each([
    ['no_key', 'CARD_RAIL_KEY_MISSING'],
    ['key_rejected', 'CARD_RAIL_KEY_REJECTED'],
    ['unavailable', 'CARD_RAIL_UNAVAILABLE'],
    ['request_rejected', 'CARD_RAIL_REQUEST_REJECTED'],
  ])('a Stripe %s failure on the issuer\'s account is a 502 carrying %s, and records no transaction', async (code, expected) => {
    state.resolveCardRailMock.mockResolvedValue(CONNECTOR_RAIL);
    state.getPaymentRequestByIdMock.mockResolvedValue(HANDLED_REQUEST);
    state.createByoSessionMock.mockRejectedValue(new ByoCheckoutError(code as 'no_key', `stripe: ${code}`, 403));

    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(result).toMatchObject({ status: 502, code: expected });
    expect(state.insertCalls).toHaveLength(0);
  });

  it('does not swallow an unexpected (non-Stripe) error', async () => {
    state.resolveCardRailMock.mockResolvedValue(CONNECTOR_RAIL);
    state.getPaymentRequestByIdMock.mockResolvedValue(HANDLED_REQUEST);
    state.createByoSessionMock.mockRejectedValue(new Error('db exploded'));

    await expect(createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID })).rejects.toThrow('db exploded');
  });

  it('reuses a still-open session read back with the ISSUER\'s key, not the platform client', async () => {
    state.resolveCardRailMock.mockResolvedValue(CONNECTOR_RAIL);
    state.getPaymentRequestByIdMock.mockResolvedValue(HANDLED_REQUEST);
    state.selectTxQueue.push([{ externalRef: 'cs_old' }]);
    state.retrieveByoSessionMock.mockResolvedValue({
      id: 'cs_old',
      url: 'https://checkout.stripe.com/cs_old',
      status: 'open',
      expiresAt: new Date('2026-01-02T00:00:00Z'),
    });

    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(result).toMatchObject({ id: 'cs_old', reused: true });
    expect(state.retrieveByoSessionMock).toHaveBeenCalledWith(ISSUER_DID, 'cs_old');
    expect(state.stripeSessionsRetrieveMock).not.toHaveBeenCalled();
    expect(state.createByoSessionMock).not.toHaveBeenCalled();
  });

  it('falls through to a fresh session when reading the old one back fails', async () => {
    state.resolveCardRailMock.mockResolvedValue(CONNECTOR_RAIL);
    state.getPaymentRequestByIdMock.mockResolvedValue(HANDLED_REQUEST);
    state.selectTxQueue.push([{ externalRef: 'cs_old' }]);
    state.retrieveByoSessionMock.mockRejectedValue(new ByoCheckoutError('unavailable', 'stripe down', 503));
    state.createByoSessionMock.mockResolvedValue(BYO_SESSION);

    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(result).toMatchObject({ id: 'cs_byo', reused: false });
  });

  it('falls back to Connect only when there is no connector: the Connect path is untouched', async () => {
    state.resolveCardRailMock.mockResolvedValue({ kind: 'connect' });
    state.getPaymentRequestByIdMock.mockResolvedValue(HANDLED_REQUEST);

    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(result).toMatchObject({ id: 'cs_new', reused: false });
    expect(state.createByoSessionMock).not.toHaveBeenCalled();
    expect(state.payCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ connectedAccountId: 'acct_123', applicationFeeAmount: 200 }),
    );
    expect(state.insertCalls[0]).toMatchObject({ rail: 'stripe' });
    // Connect sessions keep the original three metadata keys — the BYO-only keys never leak onto them.
    expect(state.payCheckoutMock.mock.calls[0][0].metadata).toEqual({
      payment_request_id: 'pr_1',
      service: 'payment_request',
      type: 'payment_request_checkout',
    });
  });
});

describe('settlePaymentRequestFromStripeCheckout', () => {
  const PAID_INPUT = { paymentRequestId: 'pr_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' };

  it('returns 404 when the payment_request does not exist', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(null);
    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);
    expect(result).toMatchObject({ status: 404 });
  });

  it('is an idempotent no-op when the request has already left issued status (webhook replay)', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue({ ...ISSUED_REQUEST, status: 'paid' });
    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);
    expect(result).toMatchObject({ settled: false });
    expect(state.updateCalls).toHaveLength(0);
    expect(state.settlePaymentMock).not.toHaveBeenCalled();
  });

  it('is a no-op when a concurrent webhook delivery already won the guarded transition', async () => {
    state.getPaymentRequestByIdMock
      .mockResolvedValueOnce(ISSUED_REQUEST) // initial fetch
      .mockResolvedValueOnce({ ...ISSUED_REQUEST, status: 'paid' }); // re-fetch after losing the race
    state.updateReturningQueue.push([]); // guarded UPDATE matched no row
    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);
    expect(result).toMatchObject({ settled: false });
    expect(state.settlePaymentMock).not.toHaveBeenCalled();
  });

  it('transitions issued -> paid, publishes paid, settles exactly once with the resolved manifest, mints one kernel-signed settled attestation, and publishes settled', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    state.updateReturningQueue.push([{ ...ISSUED_REQUEST, status: 'paid' }]);
    state.settlePaymentMock.mockResolvedValue({
      settled: true,
      batchId: 'batch_1',
      transactions: ['tx_1'],
      total_amount: 47.85,
      recipients: 1,
      source: 'external',
    });

    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);
    expect(result).toMatchObject({ settled: true });

    // Exactly one guarded status transition.
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0].values).toMatchObject({ status: 'paid' });
    expect((state.updateCalls[0].values.settlementRef as Record<string, unknown>)).toMatchObject({
      method: 'stripe',
      checkout_session_id: 'cs_1',
      payment_intent_id: 'pi_1',
    });

    expect(state.publishMock).toHaveBeenCalledWith('payment_request.paid', expect.objectContaining({ issuer: ISSUER_DID }));

    // Settle called exactly once, funded via Stripe, with the manifest's chain resolved to absolute amounts.
    expect(state.settlePaymentMock).toHaveBeenCalledOnce();
    const settleArgs = state.settlePaymentMock.mock.calls[0][0];
    expect(settleArgs).toMatchObject({ funded: true, funded_provider: 'stripe', service: 'pay', type: 'payment_request' });
    expect(settleArgs.fair_manifest.chain).toEqual([{ did: ISSUER_DID, role: 'seller', amount: 47.85 }]);
    expect(settleArgs.total_amount).toBeCloseTo(47.85);

    // Exactly one kernel-signed settled attestation, binding content_hash + settlement_ref.
    expect(state.settledStripeAttestationMock).toHaveBeenCalledOnce();
    const attestationArgs = state.settledStripeAttestationMock.mock.calls[0][0];
    expect(attestationArgs.contentHash).toBe('bafy-x');
    expect(attestationArgs.settlementRef).toMatchObject({ method: 'stripe', checkout_session_id: 'cs_1' });

    expect(state.publishMock).toHaveBeenCalledWith(
      'payment_request.settled',
      expect.objectContaining({ payload: expect.objectContaining({ method: 'stripe', attestationId: 'att_settled_stripe_1' }) }),
    );
  });

  it('does not mint a settled attestation or publish settled when settlePayment fails (still reports the paid transition)', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    state.updateReturningQueue.push([{ ...ISSUED_REQUEST, status: 'paid' }]);
    state.settlePaymentMock.mockResolvedValue({ error: 'insufficient balance', status: 400 });

    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);
    expect(result).toMatchObject({ settled: true });

    expect(state.settledStripeAttestationMock).not.toHaveBeenCalled();
    expect(state.publishMock).not.toHaveBeenCalledWith('payment_request.settled', expect.anything());
  });

  it('is idempotent on a pure webhook replay for the same session (no-op, settle never re-runs)', async () => {
    // First delivery already ran and moved the request to paid.
    state.getPaymentRequestByIdMock.mockResolvedValue({
      ...ISSUED_REQUEST,
      status: 'paid',
      settlementRef: { method: 'stripe', checkout_session_id: 'cs_1', payment_intent_id: 'pi_1', settled_at: '2026-01-01T00:00:00Z' },
    });

    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);
    expect(result).toMatchObject({ settled: false });
    expect(state.settlePaymentMock).not.toHaveBeenCalled();
    expect(state.settledStripeAttestationMock).not.toHaveBeenCalled();
  });

  it('#2419/#2421 (e2e): settles on basisAmount == subtotalAmount (NOT totalAmount, NOT totalAmount minus tax), and total_amount passed to settlePayment is basis - fee + tax (the gross-minus-fee actually charged)', async () => {
    // paymentRequest.subtotalAmount is the PRE-TAX line-items subtotal;
    // totalAmount = subtotal + tax is what Stripe charged. This is exactly
    // the shape `createPaymentRequest` -> `createPaymentRequestCheckoutSession`
    // produces for a request carrying `taxes[]`.
    const TAXED_REQUEST = {
      ...ISSUED_REQUEST,
      subtotalAmount: 10_000, // $100.00 pre-tax subtotal
      taxTotalAmount: 1300,
      totalAmount: 11_300, // $113.00 grand total
      fairManifest: {
        version: '0.4.0',
        fees: [],
        chain: [{ did: ISSUER_DID, role: 'seller', share: 1 }],
        distributions: [],
        attribution: [],
        total: { amount: 10_000, currency: 'CAD' },
        taxes: [
          {
            jurisdiction: 'CA-ON',
            kind: 'GST/HST',
            rateBps: 1300,
            basisAmount: 10_000, // MUST equal totalAmount (fix 1)
            amount: 1300, // $13.00 = 10000 * 1300 / 10000
            registrationNumber: '123456789RT0001',
            collectorDid: ISSUER_DID,
            remitTo: 'did:imajin:authority:ca-cra',
          },
        ],
      },
    };

    state.getPaymentRequestByIdMock.mockResolvedValue(TAXED_REQUEST);
    state.updateReturningQueue.push([{ ...TAXED_REQUEST, status: 'paid' }]);
    state.settlePaymentMock.mockResolvedValue({
      settled: true,
      batchId: 'batch_tax',
      transactions: ['tx_1', 'tx_2'],
      total_amount: 108.52,
      recipients: 1,
      source: 'external',
    });

    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);
    expect(result).toMatchObject({ settled: true });

    expect(state.settlePaymentMock).toHaveBeenCalledOnce();
    const settleArgs = state.settlePaymentMock.mock.calls[0][0];

    // Gross = 10000 + 1300 = 11300 cents; fallback fee 3.7% + 30c on GROSS:
    // 11300*370/10000 + 30 = 418.1 + 30 = 448.1 -> $4.48.
    // Chain (single seller, share 1): 100 - 4.48 = $95.52 — computed on the
    // pre-tax basis (100), NOT on 100 - 13 = 87 (the #1 regression).
    expect(settleArgs.fair_manifest.chain).toEqual([{ did: ISSUER_DID, role: 'seller', amount: 95.52 }]);

    // One resolved tax credit, full $13.00, to the collector — kept OUT of chain.
    expect(settleArgs.fair_manifest.taxCredits).toEqual([
      {
        did: ISSUER_DID,
        amount: 13,
        jurisdiction: 'CA-ON',
        kind: 'GST/HST',
        rateBps: 1300,
        remitTo: 'did:imajin:authority:ca-cra',
        registrationNumber: '123456789RT0001',
      },
    ]);

    // total_amount == chain Σ (95.52) + taxCredits Σ (13) == 108.52 — the
    // GROSS actually charged, minus the processor fee. NOT the subtotal
    // (100) and NOT the erroneous "subtotal minus tax" (87) the pre-fix
    // code would have produced.
    expect(settleArgs.total_amount).toBeCloseTo(108.52, 2);

    // The kernel-signed receipt attestation carries the same breakdown.
    const attestationArgs = state.settledStripeAttestationMock.mock.calls[0][0];
    expect(attestationArgs.totalAmount).toBe(11_300);
    expect(attestationArgs.tax).toEqual({
      subtotalAmount: 10_000,
      taxTotalAmount: 1300,
      taxes: [
        { jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 1300, registrationNumber: '123456789RT0001' },
      ],
    });
  });

  it('a request without tax hands the receipt attestation no breakdown (payload unchanged)', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    state.updateReturningQueue.push([{ ...ISSUED_REQUEST, status: 'paid' }]);
    state.settlePaymentMock.mockResolvedValue({ settled: true, batchId: 'b', transactions: [], total_amount: 47.85, recipients: 1, source: 'external' });

    await settlePaymentRequestFromStripeCheckout(PAID_INPUT);
    expect(state.settledStripeAttestationMock.mock.calls[0][0].tax).toBeNull();
  });

  it('#2419/#2421 (e2e): skips settlement (no DB writes) when a tax row\'s basisAmount does not match subtotalAmount', async () => {
    const MISMATCHED_REQUEST = {
      ...ISSUED_REQUEST,
      subtotalAmount: 10_000,
      taxTotalAmount: 1170,
      totalAmount: 11_170,
      fairManifest: {
        version: '0.4.0',
        fees: [],
        chain: [{ did: ISSUER_DID, role: 'seller', share: 1 }],
        distributions: [],
        attribution: [],
        total: { amount: 10_000, currency: 'CAD' },
        taxes: [
          {
            jurisdiction: 'CA-ON',
            kind: 'GST/HST',
            rateBps: 1300,
            basisAmount: 9_000, // MISMATCH — should equal totalAmount (10_000)
            amount: 1170,
            registrationNumber: '123456789RT0001',
            collectorDid: ISSUER_DID,
            remitTo: 'did:imajin:authority:ca-cra',
          },
        ],
      },
    };

    state.getPaymentRequestByIdMock.mockResolvedValue(MISMATCHED_REQUEST);
    state.updateReturningQueue.push([{ ...MISMATCHED_REQUEST, status: 'paid' }]);

    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);
    // The 'issued -> paid' transition and 'paid' publish still happen —
    // only the settle step (which needs a trustworthy basis) is skipped.
    expect(result).toMatchObject({ settled: true });
    expect(state.settlePaymentMock).not.toHaveBeenCalled();
    expect(state.settledStripeAttestationMock).not.toHaveBeenCalled();
    // #2439: skipping after money has moved is no longer silent — the operator is alerted.
    expect(settlementFailedPublishes()).toHaveLength(1);
    expect(settlementFailedPublishes()[0][1].payload).toMatchObject({ paymentRequestId: 'pr_1', reason: 'basis_mismatch' });
  });
});

/** Every `payment_request.settlement_failed` publish() call as `[type, event]`. */
function settlementFailedPublishes(): Array<[string, { issuer: string; subject: string; scope: string; payload: Record<string, unknown> }]> {
  return state.publishMock.mock.calls.filter(([type]) => type === 'payment_request.settlement_failed');
}

const SETTLED_OK = { settled: true, batchId: 'b', transactions: [], total_amount: 47.85, recipients: 1, source: 'external' };
const STRIPE_REF = { method: 'stripe', checkout_session_id: 'cs_1', payment_intent_id: 'pi_1', settled_at: '2026-01-01T00:00:00Z' };

describe('settlement failure alerting (#2439 — money has moved, so no silent log-only failures)', () => {
  const PAID_INPUT = { paymentRequestId: 'pr_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' };

  function arrangePaid(request: Record<string, unknown> = ISSUED_REQUEST) {
    state.getPaymentRequestByIdMock.mockResolvedValue(request);
    state.updateReturningQueue.push([{ ...request, status: 'paid' }]);
  }

  it('a rejected settlement (settlePayment error) alerts the operator with the reason and error', async () => {
    arrangePaid();
    state.settlePaymentMock.mockResolvedValue({ error: 'Each taxCredits item must have a non-empty registrationNumber', status: 400 });

    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);

    expect(result).toMatchObject({ settled: true }); // the webhook still gets its 200
    expect(settlementFailedPublishes()).toHaveLength(1);
    const [, event] = settlementFailedPublishes()[0];
    expect(event).toMatchObject({ issuer: 'did:imajin:node', subject: 'did:imajin:node', scope: 'pay' });
    expect(event.payload).toMatchObject({
      paymentRequestId: 'pr_1',
      reason: 'settle_rejected',
      error: 'Each taxCredits item must have a non-empty registrationNumber',
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      totalAmount: 5000,
      currency: 'CAD',
      method: 'stripe',
      context_id: 'pr_1',
      context_type: 'payment_request',
    });
  });

  it('an empty chain alerts with reason empty_chain and never calls settlePayment', async () => {
    arrangePaid({ ...ISSUED_REQUEST, fairManifest: { ...ISSUED_REQUEST.fairManifest, chain: [] } });

    await settlePaymentRequestFromStripeCheckout(PAID_INPUT);

    expect(state.settlePaymentMock).not.toHaveBeenCalled();
    expect(settlementFailedPublishes()).toHaveLength(1);
    expect(settlementFailedPublishes()[0][1].payload).toMatchObject({ reason: 'empty_chain', error: 'fair_manifest.chain is empty' });
  });

  it('a basis mismatch names both amounts in the alert', async () => {
    arrangePaid({
      ...ISSUED_REQUEST,
      fairManifest: {
        ...ISSUED_REQUEST.fairManifest,
        taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, basisAmount: 4000, amount: 520, registrationNumber: 'R', collectorDid: ISSUER_DID, remitTo: 'did:imajin:authority:ca-cra' }],
      },
    });

    await settlePaymentRequestFromStripeCheckout(PAID_INPUT);

    expect(settlementFailedPublishes()[0][1].payload).toMatchObject({
      reason: 'basis_mismatch',
      error: 'taxes[].basisAmount (4000) does not match subtotalAmount (5000)',
    });
  });

  it('an exception inside settlement alerts with reason settle_error and does not fail the webhook', async () => {
    arrangePaid();
    state.settlePaymentMock.mockRejectedValue(new Error('db down'));

    const result = await settlePaymentRequestFromStripeCheckout(PAID_INPUT);

    expect(result).toMatchObject({ settled: true });
    expect(settlementFailedPublishes()[0][1].payload).toMatchObject({ reason: 'settle_error', error: 'Error: db down' });
  });

  it('falls back to the issuer DID as the alert subject when the node DID is unresolved', async () => {
    arrangePaid();
    state.getNodeDidMock.mockResolvedValue('');
    state.settlePaymentMock.mockResolvedValue({ error: 'nope', status: 400 });

    await settlePaymentRequestFromStripeCheckout(PAID_INPUT);

    expect(settlementFailedPublishes()[0][1]).toMatchObject({ issuer: ISSUER_DID, subject: ISSUER_DID });
  });

  it('a failing alert publish is swallowed — the webhook never throws', async () => {
    arrangePaid();
    state.settlePaymentMock.mockResolvedValue({ error: 'nope', status: 400 });
    state.publishMock.mockImplementation((type: string) =>
      type === 'payment_request.settlement_failed' ? Promise.reject(new Error('bus down')) : Promise.resolve(undefined),
    );

    await expect(settlePaymentRequestFromStripeCheckout(PAID_INPUT)).resolves.toMatchObject({ settled: true });
  });

  it('a successful settlement publishes no alert', async () => {
    arrangePaid();
    state.settlePaymentMock.mockResolvedValue(SETTLED_OK);

    await settlePaymentRequestFromStripeCheckout(PAID_INPUT);

    expect(settlementFailedPublishes()).toHaveLength(0);
  });
});

describe('retryPaymentRequestStripeSettlement (#2439 — the operator retry path)', () => {
  const PAID_STRIPE = { ...ISSUED_REQUEST, status: 'paid', settlementRef: STRIPE_REF };

  it('404s for an unknown payment_request', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(null);
    expect(await retryPaymentRequestStripeSettlement('pr_missing')).toMatchObject({ status: 404 });
  });

  it.each([
    ['issued', { ...ISSUED_REQUEST }],
    ['settled_manual', { ...ISSUED_REQUEST, status: 'settled_manual', settlementRef: { method: 'manual' } }],
    ['paid but not via Stripe', { ...ISSUED_REQUEST, status: 'paid', settlementRef: { method: 'mjnx' } }],
    ['paid with no settlement ref', { ...ISSUED_REQUEST, status: 'paid', settlementRef: null }],
  ])('409s when the request is %s — only a Stripe-paid request can be re-settled', async (_label, request) => {
    state.getPaymentRequestByIdMock.mockResolvedValue(request);
    expect(await retryPaymentRequestStripeSettlement('pr_1')).toMatchObject({ status: 409 });
    expect(state.settlePaymentMock).not.toHaveBeenCalled();
  });

  it('#2754: 409s a request paid on the issuer\'s own Stripe account — it has no platform ledger settlement to retry', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue({
      ...ISSUED_REQUEST,
      status: 'paid',
      settlementRef: { method: 'stripe', byo: true, payment_intent_id: 'pi_byo' },
    });

    const result = await retryPaymentRequestStripeSettlement('pr_1');

    expect(result).toMatchObject({ status: 409 });
    expect(state.settlePaymentMock).not.toHaveBeenCalled();
  });

  it('409s and never settles twice when ledger rows already exist for the request', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(PAID_STRIPE);
    state.selectTxQueue.push([{ id: 'tx_existing' }]);

    const result = await retryPaymentRequestStripeSettlement('pr_1');

    expect(result).toMatchObject({ status: 409 });
    expect(result).toMatchObject({ error: expect.stringMatching(/already has settlement ledger rows/) });
    expect(state.settlePaymentMock).not.toHaveBeenCalled();
    expect(state.settledStripeAttestationMock).not.toHaveBeenCalled();
  });

  it('re-runs the settlement, attests and announces it, and alerts nothing when it succeeds', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(PAID_STRIPE);
    state.settlePaymentMock.mockResolvedValue(SETTLED_OK);

    const result = await retryPaymentRequestStripeSettlement('pr_1');

    expect(result).toMatchObject({ settled: true, paymentRequest: { id: 'pr_1' } });
    expect(state.settlePaymentMock).toHaveBeenCalledOnce();
    expect(state.settlePaymentMock.mock.calls[0][0]).toMatchObject({
      funded: true,
      funded_provider: 'stripe',
      metadata: { payment_request_id: 'pr_1' },
    });
    expect(state.settledStripeAttestationMock.mock.calls[0][0].settlementRef).toMatchObject(STRIPE_REF);
    expect(state.publishMock).toHaveBeenCalledWith('payment_request.settled', expect.anything());
    expect(settlementFailedPublishes()).toHaveLength(0);
    // A retry never touches the request's status — it is already `paid`.
    expect(state.updateCalls).toHaveLength(0);
  });

  it('#2665: re-settles an e-Transfer-paid request on the e-Transfer rail (no Stripe fee, issuer-signed attestation, alert names the rail)', async () => {
    const EMT_REF = { method: 'emt', asserted_by: ISSUER_DID, reference: 'INV-PR1', settled_at: '2026-01-01T00:00:00.000Z' };
    const feeManifest = {
      ...ISSUED_REQUEST.fairManifest,
      fees: [{ role: 'processor', rateBps: 370, fixedCents: 30 }],
    };
    state.getPaymentRequestByIdMock.mockResolvedValue({
      ...ISSUED_REQUEST,
      status: 'paid',
      settlementRef: EMT_REF,
      fairManifest: feeManifest,
    });
    state.settlePaymentMock.mockResolvedValue(SETTLED_OK);

    expect(await retryPaymentRequestStripeSettlement('pr_1')).toMatchObject({ settled: true });

    const call = state.settlePaymentMock.mock.calls[0][0];
    expect(call).toMatchObject({ funded_provider: 'emt', total_amount: 50 });
    expect(state.settledAttestationMock.mock.calls[0][0]).toMatchObject({ method: 'emt', assertedBy: ISSUER_DID, reference: 'INV-PR1' });
    expect(state.settledStripeAttestationMock).not.toHaveBeenCalled();

    // …and a failing e-Transfer re-settle alerts with method 'emt'.
    state.getPaymentRequestByIdMock.mockResolvedValue({
      ...ISSUED_REQUEST,
      status: 'paid',
      settlementRef: EMT_REF,
      fairManifest: { ...feeManifest, chain: [] },
    });
    expect(await retryPaymentRequestStripeSettlement('pr_1')).toMatchObject({ status: 422 });
    expect(settlementFailedPublishes().at(-1)![1].payload).toMatchObject({ method: 'emt', reason: 'empty_chain' });
  });

  it('a retry that still cannot settle re-alerts the operator and answers 422 with the reason', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue({ ...PAID_STRIPE, fairManifest: { ...ISSUED_REQUEST.fairManifest, chain: [] } });

    const result = await retryPaymentRequestStripeSettlement('pr_1');

    expect(result).toMatchObject({ status: 422, error: expect.stringMatching(/empty_chain/) });
    expect(state.settlePaymentMock).not.toHaveBeenCalled();
    expect(settlementFailedPublishes()).toHaveLength(1);
  });

  it('fix-then-retry: a basis-mismatch failure is alerted, and once the manifest is corrected the retry settles', async () => {
    const staleTax = { jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, basisAmount: 4000, amount: 520, registrationNumber: '123456789RT0001', collectorDid: ISSUER_DID, remitTo: 'did:imajin:authority:ca-cra' };
    const stale = { ...ISSUED_REQUEST, fairManifest: { ...ISSUED_REQUEST.fairManifest, taxes: [staleTax] } };
    state.getPaymentRequestByIdMock.mockResolvedValue(stale);
    state.updateReturningQueue.push([{ ...stale, status: 'paid', settlementRef: STRIPE_REF }]);

    // 1. Webhook: settlement skipped, operator alerted, nothing settled.
    await settlePaymentRequestFromStripeCheckout({ paymentRequestId: 'pr_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' });
    expect(settlementFailedPublishes()[0][1].payload).toMatchObject({ reason: 'basis_mismatch' });
    expect(state.settlePaymentMock).not.toHaveBeenCalled();

    // 2. Retrying before the fix fails the same way (and re-alerts).
    state.getPaymentRequestByIdMock.mockResolvedValue({ ...stale, status: 'paid', settlementRef: STRIPE_REF });
    expect(await retryPaymentRequestStripeSettlement('pr_1')).toMatchObject({ status: 422 });
    expect(settlementFailedPublishes()).toHaveLength(2);

    // 3. The operator fixes the manifest; the retry now settles.
    const fixed = {
      ...stale,
      status: 'paid',
      settlementRef: STRIPE_REF,
      fairManifest: { ...stale.fairManifest, taxes: [{ ...staleTax, basisAmount: 5000, amount: 650 }] },
    };
    state.getPaymentRequestByIdMock.mockResolvedValue(fixed);
    state.settlePaymentMock.mockResolvedValue(SETTLED_OK);
    expect(await retryPaymentRequestStripeSettlement('pr_1')).toMatchObject({ settled: true });
    expect(state.settlePaymentMock).toHaveBeenCalledOnce();
    expect(state.settlePaymentMock.mock.calls[0][0].fair_manifest.taxCredits[0]).toMatchObject({ registrationNumber: '123456789RT0001' });
    expect(settlementFailedPublishes()).toHaveLength(2);
  });
});
