import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  settle: vi.fn(),
  owner: vi.fn(),
  unseal: vi.fn(),
  ready: vi.fn(),
}));

vi.mock('@/src/lib/stripe/connector-core', () => ({
  stripe: { keySealed: h.ready, resolveActiveGrant: h.ready },
  stripeEventsScope: 'stripe:events',
  stripePublishableKeyField: (did: string) => `stripe-publishable-key:${did}`,
  stripeWebhookSecretField: (did: string) => `stripe-webhook-secret:${did}`,
}));
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: h.unseal }));
vi.mock('@/src/lib/stripe/webhook-index', () => ({ resolveWebhookOwner: h.owner }));
vi.mock('@/src/lib/stripe/byo-checkout', () => ({ assertCheckoutSessionWriteAllowed: vi.fn() }));
vi.mock('@/src/lib/pay/payment-requests/byo-settlement', () => ({ settlePaymentRequestFromByoStripe: h.settle }));
vi.mock('@/src/lib/pay/byo-checkout-settlement', () => ({ settleCheckoutFromByoStripe: vi.fn() }));
vi.mock('@/src/lib/pay/node-topup-settlement', () => ({ settleNodeTopupFromStripe: vi.fn() }));
vi.mock('@/src/db', () => ({ db: {}, transactions: {}, feeLedger: {} }));
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({ settlePaymentRequestFromStripeCheckout: vi.fn() }));
vi.mock('@/src/lib/pay/webhook-handlers', () => ({ notifyCheckoutServices: vi.fn() }));
vi.mock('@/src/lib/pay/withdraw-intent', () => ({ confirmWithdrawalFromRailEvent: vi.fn() }));
vi.mock('@/src/lib/pay/rails/registry', () => ({ getWithdrawRailByName: vi.fn() }));
vi.mock('@imajin/bus', async () =>
  (await import('@/src/lib/pay/__tests__/in-process-bus')).createInProcessBusMock(vi.fn()));

import { POST } from '../[routingId]/route';

const ownerDid = 'did:imajin:fake-seller';
const fakeSecret = 'whsec_fake_owner';
let eventCounter = 0;

function delivery(eventId: string, signingSecret = fakeSecret, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify({
    id: eventId,
    type: 'payment_intent.succeeded',
    data: { object: {
      id: 'pi_fake', amount: 1500, currency: 'cad',
      metadata: { payment_request_id: 'pr_fake', ownerDid: 'did:imajin:untrusted' },
    } },
  });
  const signature = createHmac('sha256', signingSecret).update(`${timestamp}.${body}`).digest('hex');
  return new Request('https://node.example/pay/api/webhook/stripewh_fake', {
    method: 'POST', body, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
  }) as NextRequest;
}

function post(eventId: string, signingSecret?: string, timestamp?: number) {
  return POST(delivery(eventId, signingSecret, timestamp), { params: Promise.resolve({ routingId: 'stripewh_fake' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.owner.mockResolvedValue({ ownerDid, endpointId: '' });
  h.unseal.mockResolvedValue(fakeSecret);
  h.ready.mockResolvedValue(true);
  h.settle.mockResolvedValue({ settled: true });
  eventCounter++;
});

describe('bound Stripe signature to owner settlement', () => {
  it('settles using the stored owner, never the payload identity', async () => {
    expect((await post(`evt_bound_${eventCounter}`)).status).toBe(200);
    expect(h.unseal).toHaveBeenCalledWith(`stripe-webhook-secret:${ownerDid}`);
    expect(h.settle).toHaveBeenCalledWith({
      ownerDid, paymentRequestId: 'pr_fake', paymentIntentId: 'pi_fake', amount: 1500, currency: 'CAD',
    });
  });

  it('rejects another DID secret before any settlement', async () => {
    expect((await post(`evt_bound_${eventCounter}`, 'whsec_fake_other_did')).status).toBe(400);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('rejects unknown routing before loading any signing secret', async () => {
    h.owner.mockResolvedValue(undefined);
    expect((await post(`evt_bound_${eventCounter}`)).status).toBe(404);
    expect(h.unseal).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('suppresses a fresh signed replay only after successful settlement', async () => {
    const id = `evt_bound_${eventCounter}`;
    expect((await post(id)).status).toBe(200);
    expect((await post(id)).status).toBe(200);
    expect(h.settle).toHaveBeenCalledTimes(1);
    expect((await post(id, 'whsec_fake_other_did')).status).toBe(400);
  });

  it('rejects a stale signature even with the correct DID secret', async () => {
    expect((await post(`evt_bound_${eventCounter}`, fakeSecret, Math.floor(Date.now() / 1000) - 600)).status).toBe(400);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('returns 500 for failed settlement and processes the next signed retry', async () => {
    const id = `evt_bound_${eventCounter}`;
    h.settle.mockRejectedValueOnce(new Error('fake database outage'));
    expect((await post(id)).status).toBe(500);
    expect((await post(id)).status).toBe(200);
    expect(h.settle).toHaveBeenCalledTimes(2);
  });
});
