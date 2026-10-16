import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const h = vi.hoisted(() => ({
  grant: vi.fn(), keySealed: vi.fn(), load: vi.fn(), resolveOwner: vi.fn(), publish: vi.fn(),
  normalize: vi.fn(), settleInvoice: vi.fn(), settleCheckout: vi.fn(), notify: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@imajin/bus', () => ({ publish: h.publish, registerReactor: vi.fn() }));
vi.mock('@/src/lib/stripe/connector-core', () => ({
  stripe: { keySealed: h.keySealed, resolveActiveGrant: h.grant },
  stripeEventsScope: 'stripe:events', stripeConnectorDid: 'did:imajin:stripe-connector',
  stripePublishableKeyField: (did: string) => `stripe-publishable-key:${did}`,
  stripeWebhookSecretField: (did: string) => `stripe-webhook-secret:${did}`,
}));
vi.mock('@/src/lib/vault', () => ({
  loadAndUnseal: h.load, sealAndStore: vi.fn(), deleteFromVault: vi.fn(), vaultFieldStatus: vi.fn(),
}));
vi.mock('@/src/lib/stripe/webhook-index', () => ({
  resolveWebhookOwner: h.resolveOwner, upsertWebhookIndex: vi.fn(),
  findWebhookIndexByOwner: vi.fn(), deleteWebhookIndexByOwner: vi.fn(),
}));
vi.mock('@/src/lib/stripe/byo-checkout', () => ({ assertCheckoutSessionWriteAllowed: vi.fn() }));
// The actual owner consumer runs. Any attempted legacy platform dispatch is observable
// through normalize, and the empty DB stub makes arbitrary transaction writes fail.
vi.mock('@/src/db', () => ({ db: {}, transactions: {}, feeLedger: {} }));
vi.mock('@/src/lib/pay/external-ref', () => ({ externalRefColumns: vi.fn(), whereExternalRef: vi.fn() }));
vi.mock('@/src/lib/pay/providers/stripe-webhook', () => ({ toRailEvent: h.normalize }));
vi.mock('@/src/lib/pay/withdraw-intent', () => ({ confirmWithdrawalFromRailEvent: vi.fn() }));
vi.mock('@/src/lib/pay/rails/registry', () => ({ getWithdrawRailByName: vi.fn() }));
vi.mock('@/src/lib/pay/providers/stripe-withdraw-rail', () => ({ stripeRailName: 'stripe' }));
vi.mock('@/src/lib/pay/webhook-handlers', () => ({ notifyCheckoutServices: h.notify }));
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({ settlePaymentRequestFromStripeCheckout: vi.fn() }));
vi.mock('@/src/lib/pay/payment-requests/byo-settlement', () => ({ settlePaymentRequestFromByoStripe: h.settleInvoice }));
vi.mock('@/src/lib/pay/byo-checkout-settlement', () => ({ settleCheckoutFromByoStripe: h.settleCheckout }));

import { POST } from '../route';
import { payStripeReactor } from '@/src/lib/pay/stripe-bus-consumer';
import { getRelayEntry, putRelayEntry, deleteRelayEntry } from '@/src/lib/pay/stripe-relay-store';
import { stripeWebhookEvents, type StripeWebhookEventType } from '@/src/lib/stripe/webhook-events';
import { stripeWebhookObjects } from '@/src/lib/stripe/__tests__/webhook-fixtures';

const OWNER = 'did:imajin:fake-owner';
const SECRET = 'whsec_fake_route_secret';
let sequence = 0;

function requestFor(type: string, object: Record<string, unknown>, secret = SECRET) {
  const body = JSON.stringify({ id: `evt_fake_route_${sequence++}`, type, data: { object } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return new Request('https://kernel.test/pay/api/webhook/did/stripewh_fake', {
    method: 'POST', headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` }, body,
  }) as Parameters<typeof POST>[0];
}

function deliver(request: Parameters<typeof POST>[0]) {
  return POST(request, { params: Promise.resolve({ routingId: 'stripewh_fake' }) });
}

function eventRequest(type: StripeWebhookEventType) {
  return requestFor(type, {
    ...stripeWebhookObjects[type],
    customer_email: 'private@example.test', customer: { name: 'Private customer' },
    metadata: { pay_transaction_id: 'tx_arbitrary', payment_request_id: 'pr_arbitrary', private: 'do-not-publish' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.grant.mockResolvedValue({ scopes: ['stripe:events'] });
  h.keySealed.mockResolvedValue(true);
  h.load.mockResolvedValue(SECRET);
  h.resolveOwner.mockResolvedValue({ ownerDid: OWNER });
  h.normalize.mockImplementation(() => { throw new Error('Owner event reached historical platform handler'); });
  h.settleInvoice.mockResolvedValue({ settled: false });
  h.settleCheckout.mockResolvedValue({ settled: false });
  h.publish.mockImplementation(async (type, envelope) => {
    await payStripeReactor({ type, ...envelope }, {});
  });
});

describe('POST /pay/api/webhook/did/[routingId] real connector ingress', () => {
  it.each([
    ['checkout.session.completed', { id: 'cs_fake_setup', amount_total: null, currency: null }],
    ['customer.subscription.updated', { id: 'sub_fake_no_currency', status: 'active' }],
    ['payout.paid', { id: 'po_fake_no_date', amount: 100, currency: 'cad' }],
  ] as const)('routes valid optional fields for %s without inventing missing facts', async (type, object) => {
    expect((await deliver(requestFor(type, object))).status).toBe(200);
    const payload = h.publish.mock.calls[0][1].payload;
    if (type === 'payout.paid') expect(payload.arrivalDate).toBeNull();
    else expect(payload).toMatchObject({ amount: null, currency: null });
  });
  it.each(stripeWebhookEvents)('routes valid %s onto its existing bus type with private owner attribution', async (type) => {
    // PI-success references have their own scoped-settlement suites; no references
    // here lets every fixture assert delivery without claiming a business action.
    const request = requestFor(type, {
      ...stripeWebhookObjects[type], customer_email: 'private@example.test',
      metadata: { private: 'do-not-publish' },
    });
    const response = await deliver(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, published: true });
    expect(h.publish).toHaveBeenCalledOnce();
    const [busType, envelope] = h.publish.mock.calls[0];
    expect(busType).toBe(`stripe.${type}`);
    expect(envelope).toMatchObject({
      issuer: OWNER, subject: OWNER, scope: 'stripe',
      payload: { ownerDid: OWNER, relayId: expect.any(String) },
    });
    expect(JSON.stringify(envelope)).not.toMatch(/private@example|do-not-publish|customer_email|metadata/);
    expect(h.load).toHaveBeenCalledWith(`stripe-webhook-secret:${OWNER}`);
    expect(getRelayEntry(envelope.payload.relayId)).toBeUndefined();
    expect(h.normalize).not.toHaveBeenCalled();
    expect(h.settleInvoice).not.toHaveBeenCalled();
    expect(h.settleCheckout).not.toHaveBeenCalled();
    if (type.startsWith('customer.subscription.')) expect(envelope.payload.amount).toBeNull();
  });

  it.each(stripeWebhookEvents)('keeps no stripe:events grant retryable (503) for %s', async (type) => {
    h.grant.mockResolvedValue(undefined);
    const response = await deliver(eventRequest(type));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Webhook connector unavailable' });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it.each(stripeWebhookEvents)('does not acknowledge failed %s publication; retry succeeds then replay is suppressed', async (type) => {
    const request = requestFor(type, stripeWebhookObjects[type]);
    const retry = request.clone() as Parameters<typeof POST>[0];
    const replay = request.clone() as Parameters<typeof POST>[0];
    h.publish.mockRejectedValueOnce(new Error('private upstream object'));
    const failed = await deliver(request);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'Webhook processing failed' });
    expect((await deliver(retry)).status).toBe(200);
    const duplicate = await deliver(replay);
    expect(await duplicate.json()).toEqual({ received: true, published: false });
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it.each(stripeWebhookEvents)('rejects malformed mapped %s payloads before reaching the bus', async (type) => {
    const response = await deliver(requestFor(type, { ...stripeWebhookObjects[type], id: null }));
    expect(response.status).toBe(400);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it.each(stripeWebhookEvents.filter((type) => type !== 'payment_intent.succeeded'))(
    'does not settle arbitrary transaction/invoice metadata on owner %s', async (type) => {
      expect((await deliver(eventRequest(type))).status).toBe(200);
      expect(h.normalize).not.toHaveBeenCalled();
      expect(h.settleInvoice).not.toHaveBeenCalled();
      expect(h.settleCheckout).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
      expect(JSON.stringify(h.publish.mock.calls)).not.toMatch(/tx_arbitrary|pr_arbitrary|Private customer/);
    },
  );

  it.each(['transfer.created', 'charge.dispute.created'])('acknowledges unsupported %s without claiming it was published', async (type) => {
    const response = await deliver(requestFor(type, { id: 'fake_legacy' }));
    expect(await response.json()).toEqual({ received: true, published: false });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('rejects another owner signing secret, even when metadata names the indexed DID', async () => {
    const response = await deliver(requestFor('checkout.session.completed', {
      ...stripeWebhookObjects['checkout.session.completed'], metadata: { ownerDid: OWNER },
    }, 'whsec_fake_other_owner'));
    expect(response.status).toBe(400);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('retries when the pay-stripe reactor never runs', async () => {
    h.publish.mockResolvedValueOnce(undefined);
    expect((await deliver(eventRequest('checkout.session.completed'))).status).toBe(500);
  });

  it.each([
    ['issuer', 'did:imajin:other'], ['subject', 'did:imajin:other'], ['type', 'stripe.invoice.paid'],
  ])('refuses a relay envelope with mismatched %s', async (field, value) => {
    const relayId = 'fake_mismatch';
    const entry = putRelayEntry(relayId, 'platform', { type: 'checkout.session.completed' }, OWNER);
    try {
      await payStripeReactor({
        type: 'stripe.checkout.session.completed', issuer: OWNER, subject: OWNER, scope: 'stripe',
        payload: { ownerDid: OWNER, relayId }, [field]: value,
      }, {});
      expect(entry.handled).toBe(false);
      expect(entry.error).toMatch(/Connector (owner|event) mismatch/);
      expect(h.normalize).not.toHaveBeenCalled();
    } finally {
      deleteRelayEntry(relayId);
    }
  });

  it('does not claim a legacy-only event has an owner consumer', async () => {
    const relayId = 'fake_unsupported';
    const entry = putRelayEntry(relayId, 'platform', { type: 'transfer.created' }, OWNER);
    try {
      await payStripeReactor({
        type: 'stripe.transfer.created', issuer: OWNER, subject: OWNER, scope: 'stripe',
        payload: { ownerDid: OWNER, relayId },
      }, {});
      expect(entry.handled).toBe(false);
      expect(entry.error).toBe('Connector event mismatch');
      expect(h.normalize).not.toHaveBeenCalled();
    } finally {
      deleteRelayEntry(relayId);
    }
  });
});
