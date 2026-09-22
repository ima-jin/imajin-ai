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
  payCheckoutMock: vi.fn(),
  stripeSessionsRetrieveMock: vi.fn(),
  settlePaymentMock: vi.fn(),
  settledStripeAttestationMock: vi.fn().mockResolvedValue('att_settled_stripe_1'),
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
  state.payCheckoutMock.mockReset();
  state.stripeSessionsRetrieveMock.mockReset();
  state.settlePaymentMock.mockReset();
  state.settledStripeAttestationMock.mockReset().mockResolvedValue('att_settled_stripe_1');
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
  return { orderBy: orderByResult };
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
  transactions: { __table: 'transactions', metadata: 'metadata', status: 'status', createdAt: 'createdAt', stripeId: 'stripeId' },
}));

vi.mock('@imajin/bus', () => ({ publish: state.publishMock }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: state.getNodeDidMock }));
vi.mock('@imajin/config', () => ({ buildPublicUrlAbsolute: (name: string) => `https://kernel.test/${name}` }));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: () => ({ checkout: state.payCheckoutMock }) }));
vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ checkout: { sessions: { retrieve: state.stripeSessionsRetrieveMock } } }),
}));
vi.mock('@/src/lib/pay/checkout', () => ({ resolveConnectedAccountFee: state.resolveConnectedAccountFeeMock }));
vi.mock('@/src/lib/pay/settle-core', () => ({ settlePayment: state.settlePaymentMock }));
vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  getPaymentRequestById: state.getPaymentRequestByIdMock,
}));
vi.mock('@/src/lib/pay/payment-requests/attestations', () => ({
  emitPaymentRequestSettledStripeAttestation: state.settledStripeAttestationMock,
}));

import { createPaymentRequestCheckoutSession, settlePaymentRequestFromStripeCheckout } from '../checkout';

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
    expect(inserted.stripeId).toBe('cs_new');
    expect(inserted.status).toBe('pending');
    expect(inserted.fairManifest).toBeUndefined();
    expect((inserted.metadata as Record<string, string>).payment_request_id).toBe('pr_1');
  });

  it('reuses an existing open Stripe session instead of creating a duplicate', async () => {
    state.getPaymentRequestByIdMock.mockResolvedValue(ISSUED_REQUEST);
    state.selectTxQueue.push([{ stripeId: 'cs_existing' }]);
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
    state.selectTxQueue.push([{ stripeId: 'cs_expired' }]);
    state.stripeSessionsRetrieveMock.mockResolvedValue({ id: 'cs_expired', status: 'expired' });

    const result = await createPaymentRequestCheckoutSession({ id: 'pr_1', callerDid: ISSUER_DID });

    expect(result).toMatchObject({ id: 'cs_new', reused: false });
    expect(state.payCheckoutMock).toHaveBeenCalledOnce();
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
});
