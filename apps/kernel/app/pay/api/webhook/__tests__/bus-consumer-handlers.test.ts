/**
 * Handler coverage for the relocated pay webhook handlers (#2177).
 *
 * The payment-intent, subscription, and invoice handlers moved verbatim from
 * `route.ts` into the `pay-stripe` bus consumer. They had no dedicated suite
 * (the golden/tax suites pin `checkout.session.completed` only), so this one
 * drives each through the real route -> in-process bus -> reactor path and
 * asserts the DB writes, the bus publishes, and the coffee-service
 * notifications they make — including the notification failure paths, which
 * must never fail the Stripe delivery.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface TxFixture {
  id: string;
  status: string;
}

const state = vi.hoisted(() => ({
  txRow: undefined as TxFixture | undefined,
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown>; where?: unknown }>,
  selectCalls: [] as Array<{ table: string; where?: unknown }>,
  idCounter: 0,
  constructEventMock: vi.fn(),
}));

vi.mock('@/src/db', async () => {
  const { createMockDb, tableTag } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');

  // The REAL pay.transactions columns (tagged for the mock db), so the `.where(...)` conditions the
  // handlers build can be rendered and asserted on (#2176: they must filter on rail + external_ref).
  const transactions = Object.assign((await import('@/src/db/schemas/pay')).transactions, { __table: 'transactions' });
  const feeLedger = { __table: 'feeLedger' };

  function limitResultFor(table: unknown) {
    return Promise.resolve(tableTag(table) === 'transactions' && state.txRow ? [state.txRow] : []);
  }

  const { select, update, insert } = createMockDb(state, limitResultFor);
  return { db: { select, update, insert }, transactions, feeLedger };
});

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/bus', async () =>
  (await import('@/src/lib/pay/__tests__/in-process-bus')).createInProcessBusMock(publishMock));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${state.idCounter++}`,
}));

vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: state.constructEventMock } }),
}));

vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({
  settlePaymentRequestFromStripeCheckout: vi.fn(),
}));

import { POST } from '../route';
import { renderWhere } from '@/src/lib/pay/__tests__/mock-drizzle-table';

type NextRequestLike = Parameters<typeof POST>[0];

const fetchMock = vi.fn();

function makeRequest(): NextRequestLike {
  return new Request('http://localhost:3000/pay/api/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: 'raw-body',
  }) as unknown as NextRequestLike;
}

let eventCounter = 0;

function deliver(type: string, object: Record<string, unknown>) {
  eventCounter += 1;
  state.constructEventMock.mockReturnValue({ id: `evt_handlers_${eventCounter}`, type, data: { object } });
  return POST(makeRequest());
}

function coffeePayload(callIndex = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body as string) as Record<string, unknown>;
}

const coffeeIntent = {
  id: 'pi_coffee',
  amount: 1000,
  currency: 'cad',
  receipt_email: 'tipper@example.com',
  metadata: {
    service: 'coffee',
    tipId: 'tip_1',
    pageId: 'page_1',
    pageHandle: 'handle',
    to_did: 'did:imajin:creator',
    fromDid: 'did:imajin:tipper',
    fromName: 'Tipper',
    message: 'thanks',
    buyerDid: 'did:imajin:buyer',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.txRow = undefined;
  state.insertCalls = [];
  state.updateCalls = [];
  state.selectCalls = [];
  state.idCounter = 0;
  fetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
  vi.stubGlobal('fetch', fetchMock);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.PLATFORM_DID = 'did:imajin:platform';
  process.env.COFFEE_SERVICE_URL = 'http://coffee.test';
  process.env.COFFEE_WEBHOOK_SECRET = 'coffee_secret';
});

/** Assert a recorded `.where(...)` filters on the Stripe rail's `external_ref` — never the dropped `stripe_id` column. */
function expectKeyedOnExternalRef(where: unknown, ref: string): void {
  const rendered = renderWhere(where);
  expect(rendered.sql).toContain('"external_ref"');
  expect(rendered.sql).not.toContain('stripe_id');
  expect(rendered.params).toEqual(['stripe', ref]);
}

describe('settlement + idempotency read external_ref (#2176)', () => {
  it('payment_intent.succeeded: the idempotency lookup and the status update key on external_ref', async () => {
    await deliver('payment_intent.succeeded', coffeeIntent);

    const lookup = state.selectCalls.find((c) => c.table === 'transactions');
    expectKeyedOnExternalRef(lookup?.where, 'pi_coffee');
    const update = state.updateCalls.find((c) => c.table === 'transactions');
    expectKeyedOnExternalRef(update?.where, 'pi_coffee');
  });

  it('payment_intent.succeeded: an already-completed row (found by external_ref) is skipped, not re-settled', async () => {
    state.txRow = { id: 'tx_done', status: 'completed' };

    await deliver('payment_intent.succeeded', coffeeIntent);

    expect(state.updateCalls).toHaveLength(0);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('payment_intent.payment_failed: the failure update keys on external_ref', async () => {
    await deliver('payment_intent.payment_failed', coffeeIntent);

    const update = state.updateCalls.find((c) => c.table === 'transactions');
    expect(update?.values).toEqual({ status: 'failed' });
    expectKeyedOnExternalRef(update?.where, 'pi_coffee');
  });

  it('checkout.session.completed: the idempotency lookup, the completion update and the re-read all key on external_ref', async () => {
    await deliver('checkout.session.completed', { id: 'cs_plain', metadata: {}, amount_total: 1000, currency: 'cad' });

    const lookups = state.selectCalls.filter((c) => c.table === 'transactions');
    expect(lookups.length).toBeGreaterThanOrEqual(2);
    for (const lookup of lookups) expectKeyedOnExternalRef(lookup.where, 'cs_plain');
    const update = state.updateCalls.find((c) => c.table === 'transactions' && c.values.status === 'completed');
    expectKeyedOnExternalRef(update?.where, 'cs_plain');
  });
});

describe('payment_intent.succeeded (relocated handler)', () => {
  it('completes the transaction, publishes payment.charge, and notifies the coffee service', async () => {
    const res = await deliver('payment_intent.succeeded', coffeeIntent);

    expect(res.status).toBe(200);
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ table: 'transactions', values: { status: 'completed' } }),
    );
    expect(publishMock).toHaveBeenCalledWith(
      'payment.charge',
      expect.objectContaining({
        subject: 'did:imajin:buyer',
        scope: 'pay',
        payload: expect.objectContaining({ paymentIntentId: 'pi_coffee', amount: 1000, service: 'coffee' }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://coffee.test/api/webhook/payment');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer coffee_secret');
    expect(coffeePayload()).toMatchObject({
      type: 'payment.succeeded',
      tipId: 'tip_1',
      amount: 1000,
      paymentId: 'pi_coffee',
      fromEmail: 'tipper@example.com',
      status: 'completed',
    });
  });

  it('skips a payment_intent that is already completed (durable idempotency)', async () => {
    state.txRow = { id: 'tx_1', status: 'completed' };

    const res = await deliver('payment_intent.succeeded', coffeeIntent);

    expect(res.status).toBe(200);
    expect(state.updateCalls).toHaveLength(0);
    expect(publishMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records an escrow release without touching the transaction or notifying anyone', async () => {
    const res = await deliver('payment_intent.succeeded', {
      id: 'pi_escrow',
      amount: 5000,
      currency: 'cad',
      metadata: { escrow: 'true', from_did: 'did:imajin:a', to_did: 'did:imajin:b' },
    });

    expect(res.status).toBe(200);
    expect(state.updateCalls).toHaveLength(0);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('does not notify the coffee service for a non-coffee payment, and falls back to from_did for the subject', async () => {
    const res = await deliver('payment_intent.succeeded', {
      id: 'pi_other',
      amount: 200,
      currency: 'cad',
      metadata: { service: 'market', from_did: 'did:imajin:payer' },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith('payment.charge', expect.objectContaining({ subject: 'did:imajin:payer' }));
  });

  it('still answers 200 when the coffee service rejects the notification', async () => {
    fetchMock.mockResolvedValue({ ok: false, text: () => Promise.resolve('upstream said no') });

    const res = await deliver('payment_intent.succeeded', coffeeIntent);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still answers 200 when the coffee service call throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const res = await deliver('payment_intent.succeeded', coffeeIntent);

    expect(res.status).toBe(200);
  });
});

describe('payment_intent.payment_failed (relocated handler)', () => {
  it('marks the transaction failed and notifies the coffee service', async () => {
    const res = await deliver('payment_intent.payment_failed', {
      ...coffeeIntent,
      id: 'pi_failed',
      last_payment_error: { message: 'card declined' },
    });

    expect(res.status).toBe(200);
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ table: 'transactions', values: { status: 'failed' } }),
    );
    expect(coffeePayload()).toMatchObject({ type: 'payment.failed', status: 'failed', paymentId: 'pi_failed' });
  });

  it('marks a non-coffee payment failed without notifying anyone', async () => {
    const res = await deliver('payment_intent.payment_failed', {
      id: 'pi_failed_other',
      amount: 100,
      currency: 'cad',
      metadata: { service: 'market' },
    });

    expect(res.status).toBe(200);
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ table: 'transactions', values: { status: 'failed' } }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.* (relocated handlers)', () => {
  const subscription = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    currency: 'cad',
    metadata: { service: 'coffee', from_did: 'did:imajin:fan', to_did: 'did:imajin:creator' },
    items: { data: [{ price: { unit_amount: 500 } }] },
  };

  it('created: books a completed subscription transaction in major units', async () => {
    const res = await deliver('customer.subscription.created', subscription);

    expect(res.status).toBe(200);
    const insert = state.insertCalls.find((c) => c.table === 'transactions');
    expect(insert?.values).toMatchObject({
      service: 'coffee',
      type: 'subscription',
      fromDid: 'did:imajin:fan',
      toDid: 'did:imajin:creator',
      amount: '5',
      currency: 'CAD',
      status: 'completed',
      externalRef: 'sub_1',
      rail: 'stripe',
    });
    expect(insert?.values).not.toHaveProperty('stripeId');
  });

  it('created: defaults service/recipient and a zero amount when the subscription carries neither', async () => {
    const res = await deliver('customer.subscription.created', {
      id: 'sub_bare',
      customer: 'cus_2',
      status: 'active',
      items: { data: [] },
    });

    expect(res.status).toBe(200);
    const insert = state.insertCalls.find((c) => c.table === 'transactions');
    expect(insert?.values).toMatchObject({
      service: 'subscription',
      fromDid: null,
      toDid: 'platform',
      amount: '0',
      currency: 'USD',
    });
  });

  it('updated: notifies the coffee service for a coffee subscription only', async () => {
    await deliver('customer.subscription.updated', subscription);
    expect(coffeePayload()).toMatchObject({ type: 'subscription.updated', subscriptionId: 'sub_1', status: 'active' });

    fetchMock.mockClear();
    await deliver('customer.subscription.updated', { ...subscription, id: 'sub_2', metadata: { service: 'market' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deleted: notifies the coffee service of the cancellation', async () => {
    const res = await deliver('customer.subscription.deleted', subscription);

    expect(res.status).toBe(200);
    expect(coffeePayload()).toMatchObject({ type: 'subscription.canceled', status: 'canceled', subscriptionId: 'sub_1' });
  });

  it('deleted: does nothing for a non-coffee subscription', async () => {
    const res = await deliver('customer.subscription.deleted', { ...subscription, id: 'sub_3', metadata: {} });

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the coffee notification (still 200) when the coffee service is not configured', async () => {
    delete process.env.COFFEE_SERVICE_URL;

    const res = await deliver('customer.subscription.deleted', subscription);

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still answers 200 when the subscription notification is rejected or throws', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: () => Promise.resolve('nope') });
    expect((await deliver('customer.subscription.deleted', subscription)).status).toBe(200);

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect((await deliver('customer.subscription.updated', subscription)).status).toBe(200);
  });
});

describe('invoice.paid (relocated handler)', () => {
  const invoice = {
    id: 'in_1',
    amount_paid: 1500,
    currency: 'cad',
    number: 'INV-1',
    subscription: 'sub_9',
    subscription_details: { metadata: { service: 'coffee', from_did: 'did:imajin:fan', to_did: 'did:imajin:creator' } },
  };

  it('books a renewal transaction and notifies the coffee service', async () => {
    const res = await deliver('invoice.paid', invoice);

    expect(res.status).toBe(200);
    const insert = state.insertCalls.find((c) => c.table === 'transactions');
    expect(insert?.values).toMatchObject({
      service: 'coffee',
      type: 'subscription',
      amount: '15',
      currency: 'CAD',
      status: 'completed',
      externalRef: 'in_1',
      rail: 'stripe',
      metadata: expect.objectContaining({ subscription_id: 'sub_9', invoice_number: 'INV-1' }),
    });
    expect(coffeePayload()).toMatchObject({ type: 'subscription.renewed', invoiceId: 'in_1', amount: 1500, subscriptionId: 'sub_9' });
  });

  it('reads the subscription id off an expanded subscription object', async () => {
    await deliver('invoice.paid', { ...invoice, id: 'in_obj', subscription: { id: 'sub_obj' } });

    const insert = state.insertCalls.find((c) => c.table === 'transactions');
    expect(insert?.values.metadata).toMatchObject({ subscription_id: 'sub_obj' });
    expect(coffeePayload()).toMatchObject({ subscriptionId: 'sub_obj' });
  });

  it('ignores an invoice that is not linked to a subscription', async () => {
    const res = await deliver('invoice.paid', { id: 'in_plain', amount_paid: 100, currency: 'cad' });

    expect(res.status).toBe(200);
    expect(state.insertCalls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults the service and recipient when the subscription metadata is absent', async () => {
    const res = await deliver('invoice.paid', { id: 'in_nometa', amount_paid: 300, currency: 'cad', subscription: 'sub_x' });

    expect(res.status).toBe(200);
    const insert = state.insertCalls.find((c) => c.table === 'transactions');
    expect(insert?.values).toMatchObject({ service: 'subscription', fromDid: null, toDid: 'platform', amount: '3' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
