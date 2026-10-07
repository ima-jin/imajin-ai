/**
 * End-to-end proof of the #2177 webhook -> connector-bus convergence.
 *
 * Unlike the per-route suites (which stand in a tiny in-process bus, see
 * `in-process-bus.ts`), this suite runs the REAL `@imajin/bus` `publish()`
 * with its real default chain config and registry, the REAL
 * `relayVerifiedStripeEvent`, and the REAL `pay-stripe` reactor. Only the
 * edges are faked: the Stripe SDK client (signature verification), the
 * Drizzle `db`, the raw `@imajin/db` client the bus reads chain configs
 * through (always "no row", so every chain resolves to its DEFAULTS entry),
 * and the payment_request settler (covered by its own suites).
 *
 * What it proves:
 *  - a verified `checkout.session.completed` top-up delivery reaches the
 *    ledger credit ONLY by travelling route -> `stripe.checkout.session.completed`
 *    bus event -> `pay-stripe` reactor (the route itself has no handlers);
 *  - a payment_request-linked checkout reaches `settlePaymentRequestFromStripeCheckout`
 *    (the `settlePayment()` seam, #1073) the same way;
 *  - the retry contract survives the bus: a handler failure answers 500 and the
 *    event is NOT marked processed, so Stripe's retry runs the handler again;
 *  - a `stripe.*` chain that never runs the reactor (disabled in
 *    `bus_chain_configs`) fails the delivery loudly instead of acking it;
 *  - a BYO-connector `stripe.*` event (no `relayId`) never touches the platform ledger;
 *  - an event type with no pay handler is acknowledged without publishing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

interface TxFixture {
  id: string;
  service: string;
  status: string;
  fairManifest: unknown;
}

const state = vi.hoisted(() => ({
  txRow: undefined as TxFixture | undefined,
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  failNextTransactionUpdate: false,
  /** Event types whose `bus_chain_configs` row (as the fake raw client reports it) has an empty reactor list. */
  disabledChains: new Set<string>(),
  constructEventMock: vi.fn(),
}));

vi.mock('@/src/db', async () => {
  const { createMockDb, tableTag } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');

  const transactions = { __table: 'transactions' };
  const feeLedger = { __table: 'feeLedger' };
  const balances = { __table: 'balances' };
  const balanceRollups = { __table: 'balanceRollups' };
  const connectedAccounts = { __table: 'connectedAccounts' };

  function limitResultFor(table: unknown) {
    if (tableTag(table) === 'transactions') {
      return Promise.resolve(state.txRow ? [state.txRow] : []);
    }
    return Promise.resolve([]);
  }

  // A failing handler: the top-up path's first write after the idempotency read.
  function returningResultFor(table: unknown) {
    if (tableTag(table) === 'transactions' && state.failNextTransactionUpdate) {
      state.failNextTransactionUpdate = false;
      return Promise.reject(new Error('db down'));
    }
    return Promise.resolve([{}]);
  }

  const { select, update, insert } = createMockDb(state, limitResultFor, returningResultFor);
  const db = {
    select,
    update,
    insert,
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ select, update, insert }),
  };

  return { db, transactions, feeLedger, balances, balanceRollups, connectedAccounts };
});

// The raw client the bus reads `kernel.bus_chain_configs` (and the #1884
// subscription fan-out reads its tables) through. No rows => DEFAULTS apply.
vi.mock('@imajin/db', () => {
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ');
    if (text.includes('bus_chain_configs') && state.disabledChains.has(String(values[0]))) {
      return Promise.resolve([{ reactors: [], enabled: true }]);
    }
    return Promise.resolve([]);
  };
  return { getClient: () => fakeSql };
});

vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: state.constructEventMock } }),
}));

const { settleFromCheckoutMock } = vi.hoisted(() => ({ settleFromCheckoutMock: vi.fn() }));
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({
  settlePaymentRequestFromStripeCheckout: settleFromCheckoutMock,
}));

import { getChainConfig, publish } from '@imajin/bus';
import { POST } from '../../../../app/pay/api/webhook/route';
import { __resetStripeWebhookDedupForTests } from '../providers/stripe-webhook';
import {
  PAY_STRIPE_REACTOR,
  ensurePayStripeReactorRegistered,
  hasStripeBusHandler,
  payStripeReactor,
} from '../stripe-bus-consumer';
import { deleteRelayEntry, putRelayEntry } from '../stripe-relay-store';

type NextRequestLike = Parameters<typeof POST>[0];

function makeRequest(): NextRequestLike {
  return new Request('http://localhost:3000/pay/api/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: 'raw-body',
  }) as unknown as NextRequestLike;
}

function checkoutEvent(id: string, session: Record<string, unknown>) {
  return {
    id,
    type: 'checkout.session.completed',
    data: { object: { id: `cs_${id}`, amount_total: 2500, currency: 'cad', metadata: {}, ...session } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetStripeWebhookDedupForTests();
  state.txRow = undefined;
  state.insertCalls = [];
  state.updateCalls = [];
  state.failNextTransactionUpdate = false;
  state.disabledChains.clear();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.PLATFORM_DID = 'did:imajin:platform';
  settleFromCheckoutMock.mockResolvedValue({ settled: true });
});

describe('pay webhook -> connector bus -> pay-stripe reactor (#2177)', () => {
  it('configures every pay-handled stripe.* type as a single awaited pay-stripe reactor, with no DB row needed', async () => {
    for (const type of [
      'stripe.checkout.session.completed',
      'stripe.payment_intent.succeeded',
      'stripe.account.updated',
    ]) {
      const chain = await getChainConfig(type, 'stripe');
      expect(chain.source).toBe('defaults');
      expect(chain.reactors).toEqual([{ type: PAY_STRIPE_REACTOR, config: {}, await: true, enabled: true }]);
    }
  });

  it('credits a top-up end to end: signed delivery -> stripe.* bus event -> reactor -> ledger', async () => {
    state.constructEventMock.mockReturnValue(
      checkoutEvent('evt_topup', {
        metadata: { service: 'topup', topupAmount: '25', buyerDid: 'did:imajin:buyer' },
      }),
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    const txInsert = state.insertCalls.find((c) => c.table === 'transactions');
    expect(txInsert?.values).toMatchObject({
      service: 'topup',
      type: 'topup',
      toDid: 'did:imajin:buyer',
      amount: '25',
      currency: 'CAD',
      status: 'completed',
      externalRef: 'cs_evt_topup',
      rail: 'stripe',
    });
    expect(txInsert?.values).not.toHaveProperty('stripeId');
    const balanceInsert = state.insertCalls.find((c) => c.table === 'balances');
    expect(balanceInsert?.values).toMatchObject({ did: 'did:imajin:buyer', unit: 'MJN', amount: '25' });
    expect(settleFromCheckoutMock).not.toHaveBeenCalled();
  });

  it('routes a payment_request-linked checkout into the settlePayment() seam through the bus', async () => {
    state.constructEventMock.mockReturnValue(
      checkoutEvent('evt_pr', {
        payment_intent: 'pi_pr',
        metadata: { payment_request_id: 'pr_123' },
      }),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(settleFromCheckoutMock).toHaveBeenCalledTimes(1);
    expect(settleFromCheckoutMock).toHaveBeenCalledWith({
      paymentRequestId: 'pr_123',
      checkoutSessionId: 'cs_evt_pr',
      paymentIntentId: 'pi_pr',
    });
    // The generic checkout path (ledger + chain distribution) must not run for these sessions.
    expect(state.insertCalls).toHaveLength(0);
  });

  it('answers 500 when the reactor fails, leaves the event unprocessed, and the Stripe retry succeeds', async () => {
    state.constructEventMock.mockReturnValue(
      checkoutEvent('evt_retry', {
        metadata: { service: 'topup', topupAmount: '10', buyerDid: 'did:imajin:buyer' },
      }),
    );
    state.failNextTransactionUpdate = true;

    const failed = await POST(makeRequest());
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'Webhook handler failed' });
    expect(state.insertCalls.filter((c) => c.table === 'balances')).toHaveLength(0);

    // Same event id redelivered: not a duplicate, because the failed delivery was never marked processed.
    const retried = await POST(makeRequest());
    expect(retried.status).toBe(200);
    expect((await retried.json()).duplicate).toBeUndefined();
    expect(state.insertCalls.filter((c) => c.table === 'balances')).toHaveLength(1);

    // And now that it succeeded, a further replay IS a duplicate and writes nothing more.
    const replay = await POST(makeRequest());
    expect((await replay.json()).duplicate).toBe(true);
    expect(state.insertCalls.filter((c) => c.table === 'balances')).toHaveLength(1);
  });

  it('fails the delivery (500) instead of acking it when the stripe.* chain never runs the reactor', async () => {
    state.disabledChains.add('stripe.customer.subscription.deleted');
    state.constructEventMock.mockReturnValue({
      id: 'evt_disabled',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_1', metadata: {} } },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
  });

  it('acknowledges an event type with no pay handler without publishing it', async () => {
    state.constructEventMock.mockReturnValue({
      id: 'evt_unhandled',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1', amount: 100, currency: 'cad' } },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(state.insertCalls).toHaveLength(0);
    expect(state.updateCalls).toHaveLength(0);
  });

  it('dispatches by the endpoint that verified the delivery: platform vs connect handler sets are disjoint', () => {
    expect(hasStripeBusHandler('platform', 'checkout.session.completed')).toBe(true);
    expect(hasStripeBusHandler('platform', 'transfer.created')).toBe(true);
    expect(hasStripeBusHandler('platform', 'account.updated')).toBe(false);
    expect(hasStripeBusHandler('platform', 'payout.paid')).toBe(false);
    expect(hasStripeBusHandler('connect', 'account.updated')).toBe(true);
    expect(hasStripeBusHandler('connect', 'payout.failed')).toBe(true);
    expect(hasStripeBusHandler('connect', 'checkout.session.completed')).toBe(false);
    // Prototype keys are not handlers.
    expect(hasStripeBusHandler('platform', 'constructor')).toBe(false);
  });

  it('records an error (never throws) when a relayed event has no handler for its source', async () => {
    const entry = putRelayEntry('relay-test-nohandler', 'connect', { type: 'checkout.session.completed' });
    try {
      await payStripeReactor(
        {
          type: 'stripe.checkout.session.completed',
          issuer: 'did:imajin:platform',
          subject: 'did:imajin:platform',
          scope: 'stripe',
          payload: { relayId: 'relay-test-nohandler' },
        },
        {},
      );
    } finally {
      deleteRelayEntry('relay-test-nohandler');
    }

    expect(entry.handled).toBe(false);
    expect(entry.error).toContain('no pay handler for connect event type');
  });

  it('ignores a BYO-connector stripe.* event on the same chain — it must never touch the platform ledger', async () => {
    ensurePayStripeReactorRegistered();
    state.txRow = { id: 'tx_1', service: 'market', status: 'pending', fairManifest: null };

    // Exactly what `connector.ts` publishes for an owner's own Stripe account: no `relayId`, no `source`.
    await publish('stripe.payment_intent.succeeded', {
      issuer: 'did:imajin:owner',
      subject: 'did:imajin:owner',
      scope: 'stripe',
      payload: {
        ownerDid: 'did:imajin:owner',
        eventId: 'evt_byo',
        paymentIntentId: 'pi_byo',
        amount: 5000,
        currency: 'USD',
        context_id: 'evt_byo',
        context_type: 'stripe',
      },
    });
    // And a forged/unknown relay id resolves to nothing.
    await publish('stripe.payment_intent.succeeded', {
      issuer: 'did:imajin:owner',
      subject: 'did:imajin:owner',
      scope: 'stripe',
      payload: {
        ownerDid: 'did:imajin:owner',
        eventId: 'evt_forged',
        paymentIntentId: 'pi_forged',
        amount: 5000,
        currency: 'USD',
        context_id: 'evt_forged',
        context_type: 'stripe',
        source: 'platform',
        relayId: 'not-a-real-relay-id',
      },
    });

    expect(state.insertCalls).toHaveLength(0);
    expect(state.updateCalls).toHaveLength(0);
  });
});
