/**
 * Unit tests for apps/kernel/src/lib/pay/providers/stripe-webhook.ts (#2175).
 *
 * Coverage:
 *  - verifyStripeWebhook — mandatory signature verification (missing
 *    header, invalid signature, unconfigured secret), plus the in-memory
 *    replay-idempotency guard (a marked event id is recognized as a
 *    duplicate; an unmarked one is not; a forged replay is still rejected
 *    by signature verification before the dedup check ever runs).
 *  - toRailEvent — normalization for every event type this adapter knows,
 *    and `null` for anything it deliberately leaves un-normalized.
 *  - fetchActualFee — never throws; returns `null` on any failure shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  retrievePaymentIntentMock: vi.fn(),
}));

vi.mock('../stripe-client', () => ({
  getStripeClient: () => ({
    webhooks: { constructEvent: state.constructEventMock },
    paymentIntents: { retrieve: state.retrievePaymentIntentMock },
  }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import {
  verifyStripeWebhook,
  toRailEvent,
  fetchActualFee,
  markStripeEventProcessed,
  isDuplicateStripeEvent,
  __resetStripeWebhookDedupForTests,
} from '../stripe-webhook';

beforeEach(() => {
  vi.clearAllMocks();
  __resetStripeWebhookDedupForTests();
});

describe('verifyStripeWebhook', () => {
  it('rejects with 500 when the secret is not configured', () => {
    expect(verifyStripeWebhook('body', 'sig', undefined)).toEqual({
      ok: false,
      status: 500,
      reason: 'Webhook not configured',
    });
    expect(state.constructEventMock).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the stripe-signature header is missing', () => {
    expect(verifyStripeWebhook('body', null, 'whsec_test')).toEqual({
      ok: false,
      status: 400,
      reason: 'Missing stripe-signature header',
    });
    expect(state.constructEventMock).not.toHaveBeenCalled();
  });

  it('rejects with 400 when Stripe SDK signature verification throws', () => {
    state.constructEventMock.mockImplementation(() => {
      throw new Error('signature mismatch');
    });

    expect(verifyStripeWebhook('tampered-body', 'sig_bad', 'whsec_test')).toEqual({
      ok: false,
      status: 400,
      reason: 'Invalid signature',
    });
  });

  it('returns the verified event id/type on a valid, first-time delivery', () => {
    state.constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1' } },
    });

    const result = verifyStripeWebhook('body', 'sig_ok', 'whsec_test');
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ ok: true, duplicate: false, eventId: 'evt_1', eventType: 'checkout.session.completed' });
  });

  it('does not treat a verified event as a duplicate until markStripeEventProcessed is called', () => {
    state.constructEventMock.mockReturnValue({
      id: 'evt_unmarked',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1' } },
    });

    verifyStripeWebhook('body', 'sig_ok', 'whsec_test'); // verified, but never marked
    expect(isDuplicateStripeEvent('evt_unmarked')).toBe(false);

    const second = verifyStripeWebhook('body', 'sig_ok', 'whsec_test');
    expect(second).toMatchObject({ ok: true, duplicate: false });
  });

  it('a replayed event id is recognized as a duplicate once markStripeEventProcessed has run — no double RailEvent', () => {
    const rawEvent = { id: 'evt_dup', type: 'checkout.session.completed', data: { object: { id: 'cs_dup' } } };
    state.constructEventMock.mockReturnValue(rawEvent);

    const first = verifyStripeWebhook('body', 'sig_ok', 'whsec_test');
    expect(first).toMatchObject({ ok: true, duplicate: false, eventId: 'evt_dup' });
    if (first.ok && !first.duplicate) markStripeEventProcessed(first.eventId);

    const replay = verifyStripeWebhook('body', 'sig_ok', 'whsec_test');
    expect(replay).toEqual({ ok: true, duplicate: true, eventId: 'evt_dup' });
    // The replay result carries no `event`/`eventType` at all — a caller
    // physically cannot normalize a second RailEvent from it.
    expect(replay).not.toHaveProperty('event');
  });

  it('a forged delivery reusing a known event id is still rejected by signature verification, not silently treated as a duplicate', () => {
    const rawEvent = { id: 'evt_known', type: 'checkout.session.completed', data: { object: { id: 'cs_known' } } };
    state.constructEventMock.mockReturnValueOnce(rawEvent);
    const first = verifyStripeWebhook('body', 'sig_ok', 'whsec_test');
    if (first.ok && !first.duplicate) markStripeEventProcessed(first.eventId);

    state.constructEventMock.mockImplementationOnce(() => {
      throw new Error('forged signature');
    });
    const forged = verifyStripeWebhook('tampered-body', 'sig_bad', 'whsec_test');
    expect(forged).toEqual({ ok: false, status: 400, reason: 'Invalid signature' });
  });

  it('an event with no id (defensive) is never treated as a duplicate', () => {
    state.constructEventMock.mockReturnValue({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

    const first = verifyStripeWebhook('body', 'sig_ok', 'whsec_test');
    if (first.ok && !first.duplicate) markStripeEventProcessed(first.eventId);
    const second = verifyStripeWebhook('body', 'sig_ok', 'whsec_test');

    expect(second).toMatchObject({ ok: true, duplicate: false });
  });
});

describe('toRailEvent', () => {
  it('normalizes checkout.session.completed using amount_total', () => {
    const raw = { id: 'cs_1', amount_total: 5000, currency: 'usd', metadata: { foo: 'bar' } };
    expect(toRailEvent({ type: 'checkout.session.completed', data: { object: raw } })).toEqual({
      rail: 'stripe',
      type: 'checkout.session.completed',
      externalRef: 'cs_1',
      amount: 5000,
      currency: 'usd',
      raw,
    });
  });

  it('normalizes payment_intent.succeeded using amount', () => {
    const raw = { id: 'pi_1', amount: 1200, currency: 'cad' };
    const railEvent = toRailEvent({ type: 'payment_intent.succeeded', data: { object: raw } });
    expect(railEvent).toMatchObject({ externalRef: 'pi_1', amount: 1200, currency: 'cad' });
  });

  it('normalizes invoice.paid using amount_paid', () => {
    const raw = { id: 'in_1', amount_paid: 999, currency: 'usd' };
    const railEvent = toRailEvent({ type: 'invoice.paid', data: { object: raw } });
    expect(railEvent?.amount).toBe(999);
  });

  it('normalizes account.updated with null amount/currency', () => {
    const raw = { id: 'acct_1', charges_enabled: true };
    const railEvent = toRailEvent({ type: 'account.updated', data: { object: raw } });
    expect(railEvent).toMatchObject({ externalRef: 'acct_1', amount: null, currency: null });
  });

  it('returns null for an event type this adapter deliberately does not normalize (transfer.created)', () => {
    expect(toRailEvent({ type: 'transfer.created', data: { object: { id: 'tr_1' } } })).toBeNull();
  });

  it('returns null for a malformed or absent event', () => {
    expect(toRailEvent({ type: 'checkout.session.completed' })).toBeNull();
    expect(toRailEvent({ data: { object: { id: 'x' } } })).toBeNull();
    expect(toRailEvent(null)).toBeNull();
    expect(toRailEvent(undefined)).toBeNull();
  });
});

describe('fetchActualFee', () => {
  it('returns the balance_transaction fee when present', async () => {
    state.retrievePaymentIntentMock.mockResolvedValue({ latest_charge: { balance_transaction: { fee: 42 } } });
    await expect(fetchActualFee('pi_1')).resolves.toBe(42);
  });

  it('returns null when there is no latest_charge', async () => {
    state.retrievePaymentIntentMock.mockResolvedValue({ latest_charge: null });
    await expect(fetchActualFee('pi_1')).resolves.toBeNull();
  });

  it('returns null (never throws) when the Stripe API call fails', async () => {
    state.retrievePaymentIntentMock.mockRejectedValue(new Error('network error'));
    await expect(fetchActualFee('pi_1')).resolves.toBeNull();
  });
});
