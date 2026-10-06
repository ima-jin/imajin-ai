/**
 * Unit tests for `relayVerifiedStripeEvent` (#2177) — the ingress half of the
 * pay webhook -> connector bus convergence. The consumer/bus are stubbed here;
 * `stripe-bus-convergence.test.ts` covers the real wiring end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn() }));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));

const HANDLED_TYPES = new Set(['checkout.session.completed', 'payment_intent.succeeded', 'invoice.paid', 'payout.paid']);
vi.mock('@/src/lib/pay/stripe-bus-consumer', () => ({
  ensurePayStripeReactorRegistered: vi.fn(),
  hasStripeBusHandler: (_source: string, type: string) => HANDLED_TYPES.has(type),
}));

import { relayVerifiedStripeEvent } from '../stripe-relay';
import { getRelayEntry } from '../stripe-relay-store';

/** Stand in for the reactor: resolve the relay entry from the published payload and record an outcome on it. */
function reactorOutcome(outcome: (entry: NonNullable<ReturnType<typeof getRelayEntry>>) => void) {
  publishMock.mockImplementation(async (_type: string, event: { payload: { relayId: string } }) => {
    const entry = getRelayEntry(event.payload.relayId);
    if (entry) outcome(entry);
    return {};
  });
}

const checkoutEvent = {
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_1',
      amount_total: 2500,
      currency: 'cad',
      customer_email: 'buyer@example.com',
      customer_details: { name: 'Pat Buyer', email: 'buyer@example.com' },
      metadata: { service: 'topup', buyerDid: 'did:imajin:buyer' },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLATFORM_DID = 'did:imajin:platform';
  reactorOutcome((entry) => {
    entry.handled = true;
  });
});

describe('relayVerifiedStripeEvent (#2177)', () => {
  it('publishes stripe.<type> as the platform with only non-sensitive facts — never the raw Stripe event', async () => {
    const result = await relayVerifiedStripeEvent(checkoutEvent, 'platform');

    expect(result).toEqual({ status: 'handled' });
    expect(publishMock).toHaveBeenCalledTimes(1);
    const [type, event] = publishMock.mock.calls[0];
    expect(type).toBe('stripe.checkout.session.completed');
    expect(event).toMatchObject({
      issuer: 'did:imajin:platform',
      subject: 'did:imajin:platform',
      scope: 'stripe',
      payload: {
        ownerDid: 'did:imajin:platform',
        eventId: 'evt_1',
        objectId: 'cs_1',
        amount: 2500,
        currency: 'CAD',
        source: 'platform',
        context_id: 'evt_1',
        context_type: 'stripe',
      },
    });
    expect(typeof event.payload.relayId).toBe('string');

    // Bus payloads are persisted and fanned out to subscribers: no PII, no raw event.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('Pat Buyer');
    expect(serialized).not.toContain('did:imajin:buyer');
    expect(event.payload).not.toHaveProperty('stripeEvent');
  });

  it('falls back to the "system" owner when PLATFORM_DID is unset', async () => {
    delete process.env.PLATFORM_DID;

    await relayVerifiedStripeEvent(checkoutEvent, 'platform');

    expect(publishMock.mock.calls[0][1]).toMatchObject({ issuer: 'system', payload: { ownerDid: 'system' } });
  });

  it('keeps the connector payload shape for the three shared types', async () => {
    await relayVerifiedStripeEvent(
      { id: 'evt_pi', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount: 700, currency: 'usd' } } },
      'platform',
    );
    await relayVerifiedStripeEvent(
      { id: 'evt_inv', type: 'invoice.paid', data: { object: { id: 'in_1', amount_paid: 900, currency: 'usd' } } },
      'platform',
    );
    await relayVerifiedStripeEvent(
      { id: 'evt_po', type: 'payout.paid', data: { object: { id: 'po_1', amount: 300, currency: 'usd' } } },
      'connect',
    );

    expect(publishMock.mock.calls[0][1].payload).toMatchObject({ paymentIntentId: 'pi_1', amount: 700, currency: 'USD' });
    expect(publishMock.mock.calls[1][1].payload).toMatchObject({ invoiceId: 'in_1', amountPaid: 900, currency: 'USD' });
    expect(publishMock.mock.calls[2][1].payload).toMatchObject({
      payoutId: 'po_1',
      amount: 300,
      arrivalDate: null,
      source: 'connect',
    });
  });

  it('reports null amount/currency and empty ids when the object lacks them', async () => {
    await relayVerifiedStripeEvent({ type: 'payment_intent.succeeded', data: { object: {} } }, 'platform');

    expect(publishMock.mock.calls[0][1].payload).toMatchObject({ eventId: '', objectId: '', amount: null, currency: null });
  });

  it('acknowledges an event type with no pay handler without publishing', async () => {
    const result = await relayVerifiedStripeEvent({ id: 'evt_x', type: 'charge.refunded', data: { object: {} } }, 'platform');

    expect(result).toEqual({ status: 'ignored' });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('treats a non-object / typeless event as unhandled rather than throwing', async () => {
    expect(await relayVerifiedStripeEvent(undefined, 'platform')).toEqual({ status: 'ignored' });
    expect(await relayVerifiedStripeEvent({ id: 'evt_notype' }, 'platform')).toEqual({ status: 'ignored' });
  });

  it('fails when publish() throws', async () => {
    publishMock.mockRejectedValue(new Error('Unknown reactor(s) in chain: pay-stripe'));

    const result = await relayVerifiedStripeEvent(checkoutEvent, 'platform');

    expect(result).toMatchObject({ status: 'failed' });
    expect((result as { reason: string }).reason).toContain('Unknown reactor(s)');
  });

  it('fails with the consumer\'s error when the reactor reports one', async () => {
    reactorOutcome((entry) => {
      entry.error = 'Error: db down';
    });

    const result = await relayVerifiedStripeEvent(checkoutEvent, 'platform');

    expect(result).toEqual({ status: 'failed', reason: 'Error: db down' });
  });

  it('fails when publish() completes but the reactor never ran', async () => {
    reactorOutcome(() => {
      /* chain disabled: nothing handles the entry */
    });

    const result = await relayVerifiedStripeEvent(checkoutEvent, 'platform');

    expect(result).toEqual({ status: 'failed', reason: 'pay-stripe reactor did not run' });
  });

  it('always drops the hand-off entry, on success and on failure', async () => {
    await relayVerifiedStripeEvent(checkoutEvent, 'platform');
    const successRelayId = publishMock.mock.calls[0][1].payload.relayId;
    expect(getRelayEntry(successRelayId)).toBeUndefined();

    publishMock.mockRejectedValue(new Error('boom'));
    await relayVerifiedStripeEvent(checkoutEvent, 'platform');
    const failedRelayId = publishMock.mock.calls[1][1].payload.relayId;
    expect(getRelayEntry(failedRelayId)).toBeUndefined();
  });
});
