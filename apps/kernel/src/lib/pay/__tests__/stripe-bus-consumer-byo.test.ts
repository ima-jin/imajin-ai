/**
 * #2754 / #2757: the pay-stripe reactor's two narrow exceptions to "an owner's
 * own (BYO) stripe.* event never touches the platform": a payment_request the
 * event names (#2754), and a hosted-checkout transaction it names (#2757).
 * Platform-relayed events (those with a relayId) are covered by
 * stripe-bus-convergence.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  settleByoMock: vi.fn(),
  settleCheckoutMock: vi.fn(),
  notifyServicesMock: vi.fn(),
  getRelayEntryMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('@/src/lib/pay/payment-requests/byo-settlement', () => ({ settlePaymentRequestFromByoStripe: h.settleByoMock }));
vi.mock('@/src/lib/pay/byo-checkout-settlement', () => ({ settleCheckoutFromByoStripe: h.settleCheckoutMock }));
vi.mock('@/src/lib/pay/stripe-relay-store', () => ({ getRelayEntry: h.getRelayEntryMock }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.errorMock }) }));
vi.mock('@imajin/bus', () => ({ registerReactor: vi.fn(), publish: vi.fn().mockResolvedValue(undefined) }));
// The platform handlers' heavy dependencies are irrelevant to the BYO branch.
vi.mock('@/src/db', () => ({ db: {}, transactions: {}, feeLedger: {} }));
vi.mock('@/src/lib/pay/external-ref', () => ({ externalRefColumns: vi.fn(), whereExternalRef: vi.fn() }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: vi.fn() }));
vi.mock('@/src/lib/pay/providers/stripe-webhook', () => ({ toRailEvent: vi.fn() }));
vi.mock('@/src/lib/pay/withdraw-intent', () => ({ confirmWithdrawalFromRailEvent: vi.fn() }));
vi.mock('@/src/lib/pay/rails/registry', () => ({ getWithdrawRailByName: vi.fn() }));
vi.mock('@/src/lib/pay/providers/stripe-withdraw-rail', () => ({ STRIPE_RAIL_NAME: 'stripe' }));
vi.mock('@/src/lib/pay/webhook-handlers', () => ({ notifyCheckoutServices: h.notifyServicesMock }));
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
  h.settleCheckoutMock.mockReset().mockResolvedValue({ settled: false, reason: 'not_found' });
  h.notifyServicesMock.mockReset().mockResolvedValue(undefined);
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

describe('pay-stripe reactor — BYO hosted-checkout settlement (#2757)', () => {
  const CHECKOUT_PAYLOAD = {
    ownerDid: OWNER,
    eventId: 'evt_1',
    paymentIntentId: 'pi_1',
    payTransactionId: 'tx_1',
    amount: 2500,
    currency: 'CAD',
    context_id: 'evt_1',
    context_type: 'stripe',
  };
  const SESSION = {
    id: 'cs_1',
    amount_total: 2500,
    currency: 'cad',
    customer_email: 'buyer@example.com',
    metadata: { service: 'events', eventId: 'ev_1' },
    payment_intent: 'pi_1',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('settles the checkout the owner\'s own event names, then tells the originating service it was paid', async () => {
    h.settleCheckoutMock.mockResolvedValue({ settled: true, session: SESSION });

    await payStripeReactor(byoEvent({}, CHECKOUT_PAYLOAD), {});

    expect(h.settleCheckoutMock).toHaveBeenCalledWith({
      ownerDid: OWNER,
      transactionId: 'tx_1',
      paymentIntentId: 'pi_1',
      amount: 2500,
      currency: 'CAD',
    });
    expect(h.notifyServicesMock).toHaveBeenCalledWith(SESSION);
    // It is not a payment_request: that settlement is never attempted.
    expect(h.settleByoMock).not.toHaveBeenCalled();
  });

  it('notifies nobody when the settlement refused or was a replay', async () => {
    h.settleCheckoutMock.mockResolvedValue({ settled: false, reason: 'not_pending' });

    await payStripeReactor(byoEvent({}, CHECKOUT_PAYLOAD), {});

    expect(h.notifyServicesMock).not.toHaveBeenCalled();
  });

  it('tells the coffee service for a coffee checkout, with the PaymentIntent shape it reads', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.COFFEE_SERVICE_URL = 'https://coffee.test';
    process.env.COFFEE_WEBHOOK_SECRET = 'coffee-secret';
    h.settleCheckoutMock.mockResolvedValue({
      settled: true,
      session: { ...SESSION, metadata: { service: 'coffee', tipId: 'tip_1', pageId: 'pg_1', pageHandle: 'h', to_did: 'did:imajin:page' } },
    });

    await payStripeReactor(byoEvent({}, CHECKOUT_PAYLOAD), {});

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://coffee.test/api/webhook/payment');
    expect(JSON.parse(init.body)).toMatchObject({ type: 'payment.succeeded', tipId: 'tip_1', paymentId: 'pi_1', amount: 2500, status: 'completed' });
  });

  it('tells coffee the tip was settled on the seller\'s own Stripe account (rail), so it does not call /pay/api/settle (#2773)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.COFFEE_SERVICE_URL = 'https://coffee.test';
    process.env.COFFEE_WEBHOOK_SECRET = 'coffee-secret';
    h.settleCheckoutMock.mockResolvedValue({
      settled: true,
      session: { ...SESSION, rail: 'stripe-byo', metadata: { service: 'coffee', tipId: 'tip_1', pageId: 'pg_1', pageHandle: 'h', to_did: 'did:imajin:page' } },
    });

    await payStripeReactor(byoEvent({}, CHECKOUT_PAYLOAD), {});

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ type: 'payment.succeeded', tipId: 'tip_1', rail: 'stripe-byo' });
  });

  it('sends coffee no rail when the session carries none (#2773)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.COFFEE_SERVICE_URL = 'https://coffee.test';
    process.env.COFFEE_WEBHOOK_SECRET = 'coffee-secret';
    h.settleCheckoutMock.mockResolvedValue({
      settled: true,
      session: { ...SESSION, metadata: { service: 'coffee', tipId: 'tip_1' } },
    });

    await payStripeReactor(byoEvent({}, CHECKOUT_PAYLOAD), {});

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).not.toHaveProperty('rail');
  });

  it.each([
    ['stripe.invoice.paid', {}],
    ['stripe.payment_intent.succeeded', { issuer: 'did:imajin:attacker' }],
  ])('refuses %s with a mismatched envelope or type', async (type, override) => {
    await payStripeReactor(byoEvent({ type, ...override }, CHECKOUT_PAYLOAD), {});

    expect(h.settleCheckoutMock).not.toHaveBeenCalled();
  });

  it('ignores a PaymentIntent that names no transaction', async () => {
    const withoutTx: Record<string, unknown> = { ...CHECKOUT_PAYLOAD };
    delete withoutTx.payTransactionId;

    await payStripeReactor(byoEvent({}, withoutTx), {});

    expect(h.settleCheckoutMock).not.toHaveBeenCalled();
  });

  it('never throws — a settlement or notification failure is logged, because the connector has already answered Stripe', async () => {
    h.settleCheckoutMock.mockRejectedValue(new Error('db down'));

    await expect(payStripeReactor(byoEvent({}, CHECKOUT_PAYLOAD), {})).resolves.toBeUndefined();
    expect(h.errorMock).toHaveBeenCalledWith(expect.objectContaining({ payTransactionId: 'tx_1', ownerDid: OWNER }), expect.any(String));
  });
});
