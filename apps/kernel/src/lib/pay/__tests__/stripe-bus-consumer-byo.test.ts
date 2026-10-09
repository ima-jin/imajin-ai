/**
 * #2754: the pay-stripe reactor's one narrow exception to "an owner's own
 * (BYO) stripe.* event never touches the platform". Platform-relayed events
 * (those with a relayId) are covered by stripe-bus-convergence.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  settleByoMock: vi.fn(),
  getRelayEntryMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('@/src/lib/pay/payment-requests/byo-settlement', () => ({ settlePaymentRequestFromByoStripe: h.settleByoMock }));
vi.mock('@/src/lib/pay/stripe-relay-store', () => ({ getRelayEntry: h.getRelayEntryMock }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.errorMock }) }));
vi.mock('@imajin/bus', () => ({ registerReactor: vi.fn(), publish: vi.fn().mockResolvedValue(undefined) }));
// The platform handlers' heavy dependencies are irrelevant to the BYO branch.
vi.mock('@/src/db', () => ({ db: {}, transactions: {}, feeLedger: {}, connectedAccounts: {} }));
vi.mock('@/src/lib/pay/external-ref', () => ({ externalRefColumns: vi.fn(), whereExternalRef: vi.fn() }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: vi.fn() }));
vi.mock('@/src/lib/pay/providers/stripe-webhook', () => ({ toRailEvent: vi.fn() }));
vi.mock('@/src/lib/pay/withdraw-intent', () => ({ confirmWithdrawalFromRailEvent: vi.fn() }));
vi.mock('@/src/lib/pay/rails/registry', () => ({ getWithdrawRailByName: vi.fn() }));
vi.mock('@/src/lib/pay/providers/stripe-withdraw-rail', () => ({ STRIPE_RAIL_NAME: 'stripe' }));
vi.mock('@/src/lib/pay/webhook-handlers', () => ({}));
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({ settlePaymentRequestFromStripeCheckout: vi.fn() }));

import { payStripeReactor } from '../stripe-bus-consumer';

const OWNER = 'did:imajin:imajin-inc';
const PAYLOAD = {
  ownerDid: OWNER,
  eventId: 'evt_1',
  paymentIntentId: 'pi_1',
  paymentRequestId: 'pr_1',
  amount: 226_000,
  currency: 'CAD',
  context_id: 'evt_1',
  context_type: 'stripe',
};

function byoEvent(overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = PAYLOAD) {
  return { type: 'stripe.payment_intent.succeeded', issuer: OWNER, subject: OWNER, scope: 'stripe', payload, ...overrides };
}

beforeEach(() => {
  h.settleByoMock.mockReset().mockResolvedValue({ settled: true });
  h.getRelayEntryMock.mockReset();
  h.errorMock.mockReset();
});

describe('pay-stripe reactor — BYO payment_intent.succeeded (#2754)', () => {
  it('settles the payment_request the owner\'s own event names, handing over exactly the event\'s facts', async () => {
    await payStripeReactor(byoEvent(), {});

    expect(h.settleByoMock).toHaveBeenCalledWith({
      ownerDid: OWNER,
      paymentRequestId: 'pr_1',
      paymentIntentId: 'pi_1',
      amount: 226_000,
      currency: 'CAD',
    });
    expect(h.getRelayEntryMock).not.toHaveBeenCalled();
  });

  it('ignores a BYO PaymentIntent that names no payment_request (every unrelated BYO event stays off the ledger)', async () => {
    const withoutRequest: Record<string, unknown> = { ...PAYLOAD };
    delete withoutRequest.paymentRequestId;

    await payStripeReactor(byoEvent({}, withoutRequest), {});

    expect(h.settleByoMock).not.toHaveBeenCalled();
  });

  it.each([
    ['stripe.invoice.paid'],
    ['stripe.payout.paid'],
    ['stripe.checkout.session.completed'],
  ])('ignores %s even if its payload carries a paymentRequestId — only payment_intent.succeeded settles', async (type) => {
    await payStripeReactor(byoEvent({ type }), {});

    expect(h.settleByoMock).not.toHaveBeenCalled();
  });

  it('refuses an envelope whose issuer is not the owner DID in the payload (not the connector\'s own event)', async () => {
    await payStripeReactor(byoEvent({ issuer: 'did:imajin:attacker' }), {});

    expect(h.settleByoMock).not.toHaveBeenCalled();
  });

  it.each([
    ['ownerDid', { ownerDid: 42 }],
    ['paymentIntentId', { paymentIntentId: undefined }],
    ['amount', { amount: '226000' }],
    ['currency', { currency: undefined }],
  ])('refuses a payload with a malformed %s', async (_field, override) => {
    await payStripeReactor(byoEvent({}, { ...PAYLOAD, ...override }), {});

    expect(h.settleByoMock).not.toHaveBeenCalled();
  });

  it('never throws — a settlement failure is logged, because the connector has already answered Stripe', async () => {
    h.settleByoMock.mockRejectedValue(new Error('db down'));

    await expect(payStripeReactor(byoEvent(), {})).resolves.toBeUndefined();
    expect(h.errorMock).toHaveBeenCalledWith(expect.objectContaining({ paymentRequestId: 'pr_1', ownerDid: OWNER }), expect.any(String));
  });

  it('a platform-relayed event (relayId present) never takes the BYO path', async () => {
    h.getRelayEntryMock.mockReturnValue(undefined);

    await payStripeReactor(byoEvent({}, { ...PAYLOAD, relayId: 'relay_1' }), {});

    expect(h.settleByoMock).not.toHaveBeenCalled();
    expect(h.getRelayEntryMock).toHaveBeenCalledWith('relay_1');
  });
});
