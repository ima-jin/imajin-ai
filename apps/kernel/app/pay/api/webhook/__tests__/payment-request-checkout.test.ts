/**
 * Tests for the `checkout.session.completed` -> `pay.payment_request`
 * linkage wired into the pay webhook route (#2209). Isolated from
 * `golden-webhook-settlement.test.ts` (the generic, non-payment_request
 * checkout path) — this suite mocks `settlePaymentRequestFromStripeCheckout`
 * directly rather than driving through a full DB fake, mirroring
 * `transfer-created.test.ts`'s isolation strategy. It also asserts the
 * generic checkout code path (`db.select`/`db.update` on `transactions`) is
 * never touched for a payment_request-linked session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  settleFromStripeMock: vi.fn(),
  dbSelectMock: vi.fn(),
  dbUpdateMock: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: { select: state.dbSelectMock, update: state.dbUpdateMock, insert: vi.fn() },
  transactions: {},
  feeLedger: {},
  balances: {},
  balanceRollups: {},
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));

vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: state.constructEventMock } }),
}));

vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({
  settlePaymentRequestFromStripeCheckout: state.settleFromStripeMock,
}));

import { POST } from '../route';

function makeRequest(): Parameters<typeof POST>[0] {
  return new Request('http://localhost:3000/pay/api/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: 'raw-body',
  }) as unknown as Parameters<typeof POST>[0];
}

function makeCheckoutEvent(session: Record<string, unknown>) {
  return {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_pr_1', amount_total: 5000, currency: 'cad', metadata: {}, ...session } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe("POST /pay/api/webhook — payment_request checkout.session.completed linkage (#2209)", () => {
  it('delegates to settlePaymentRequestFromStripeCheckout with the session id, payment_request id, and payment_intent id', async () => {
    state.constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: 'pi_1', metadata: { payment_request_id: 'pr_1' } }),
    );
    state.settleFromStripeMock.mockResolvedValue({ paymentRequest: { id: 'pr_1' }, settled: true });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(state.settleFromStripeMock).toHaveBeenCalledWith({
      paymentRequestId: 'pr_1',
      checkoutSessionId: 'cs_pr_1',
      paymentIntentId: 'pi_1',
    });
    // The generic checkout code path (transactions lookups) must never run for a payment_request session.
    expect(state.dbSelectMock).not.toHaveBeenCalled();
    expect(state.dbUpdateMock).not.toHaveBeenCalled();
  });

  it('resolves a string payment_intent id (not an object)', async () => {
    state.constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: { id: 'pi_expanded' }, metadata: { payment_request_id: 'pr_1' } }),
    );
    state.settleFromStripeMock.mockResolvedValue({ paymentRequest: { id: 'pr_1' }, settled: true });

    await POST(makeRequest());

    expect(state.settleFromStripeMock).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: 'pi_expanded' }),
    );
  });

  it('still returns 200 when the service reports an idempotent no-op (webhook replay)', async () => {
    state.constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: 'pi_1', metadata: { payment_request_id: 'pr_1' } }),
    );
    state.settleFromStripeMock.mockResolvedValue({ paymentRequest: { id: 'pr_1' }, settled: false });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });

  it('still returns 200 (non-fatal) when the service reports an error', async () => {
    state.constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: 'pi_1', metadata: { payment_request_id: 'pr_missing' } }),
    );
    state.settleFromStripeMock.mockResolvedValue({ error: 'payment_request not found', status: 404 });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });

  it('does not treat a generic (non-payment_request) checkout session as a payment_request linkage', async () => {
    state.constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: 'pi_1', metadata: { service: 'market_test' } }),
    );
    function limitResult() {
      return Promise.resolve([]);
    }
    function selectWhereResult() {
      return { limit: limitResult };
    }
    function updateWhereResult() {
      return Promise.resolve(undefined);
    }
    state.dbSelectMock.mockReturnValue({ from: () => ({ where: selectWhereResult }) });
    state.dbUpdateMock.mockReturnValue({ set: () => ({ where: updateWhereResult }) });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(state.settleFromStripeMock).not.toHaveBeenCalled();
  });
});
