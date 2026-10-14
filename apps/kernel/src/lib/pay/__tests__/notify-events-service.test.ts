/**
 * Tests for the events notification in apps/kernel/src/lib/pay/webhook-handlers.ts (#2739).
 *
 * Events settles through `POST /pay/api/settle`, which is keyed by the kernel `transactionId`.
 * The `checkout.completed` webhook therefore has to carry the id of the `pay.transactions` row
 * the Stripe session belongs to (looked up by `external_ref`). The lookup fails soft: no row, or a
 * lookup error, omits the field and logs — the notification must still go out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
vi.mock('../../auth/kernel-webhook-recipient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../auth/kernel-webhook-recipient')>(),
  resolveKernelWebhookAudience: vi.fn(async (_url, recipient) => `did:imajin:${recipient.appSlug}`),
}));

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  return {
    limit,
    where: vi.fn(() => ({ limit })),
    select: vi.fn(),
    whereExternalRef: vi.fn((ref: string) => ({ externalRef: ref })),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.select },
  feeLedger: {},
  balances: {},
  balanceRollups: {},
  transactions: { id: 'transactions.id' },
}));
vi.mock('@/src/lib/pay/external-ref', () => ({
  externalRefColumns: vi.fn(),
  whereExternalRef: mocks.whereExternalRef,
}));
vi.mock('drizzle-orm', () => ({ sql: vi.fn(), eq: vi.fn() }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/fair', () => ({ processorFeeCents: () => 0 }));
vi.mock('../providers/stripe-webhook', () => ({ fetchActualFee: vi.fn() }));

import { findTransactionIdForSession, notifyCheckoutServices, notifyEventsService } from '../webhook-handlers';
import type { StripeCheckoutSessionLike } from '../webhook-event-shapes';

const EVENTS_URL = 'https://events.test';
const fetchMock = vi.fn();

function eventsSession(overrides: Partial<StripeCheckoutSessionLike> = {}): StripeCheckoutSessionLike {
  return {
    id: 'cs_test_events_1',
    amount_total: 5000,
    currency: 'cad',
    payment_intent: 'pi_456',
    customer_email: 'buyer@example.com',
    metadata: { eventId: 'evt_1', service: 'events' },
    ...overrides,
  };
}

const postedBody = () => JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);

describe('events checkout notification carries the kernel transactionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_PRIVATE_KEY', authCrypto.generatePrivateKey());
    mocks.select.mockReturnValue({ from: () => ({ where: mocks.where }) });
    mocks.limit.mockResolvedValue([{ id: 'tx_abc123' }]);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('EVENTS_SERVICE_URL', EVENTS_URL);
    fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ received: true }), { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('findTransactionIdForSession', () => {
    it('returns the id of the transaction row keyed by the Stripe session id', async () => {
      await expect(findTransactionIdForSession('cs_test_events_1')).resolves.toBe('tx_abc123');

      expect(mocks.whereExternalRef).toHaveBeenCalledWith('cs_test_events_1');
      expect(mocks.log.error).not.toHaveBeenCalled();
    });

    it('returns undefined and logs when no row exists', async () => {
      mocks.limit.mockResolvedValue([]);

      await expect(findTransactionIdForSession('cs_missing')).resolves.toBeUndefined();

      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_missing' },
        expect.stringContaining('carry no transactionId'),
      );
    });

    it('fails soft (undefined, logged) when the lookup throws', async () => {
      mocks.limit.mockRejectedValue(new Error('db down'));

      await expect(findTransactionIdForSession('cs_err')).resolves.toBeUndefined();

      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_err', err: expect.stringContaining('db down') },
        expect.stringContaining('lookup failed'),
      );
    });
  });

  describe('notifyEventsService', () => {
    it('delivers without legacy bearer configuration', async () => {
      await notifyEventsService('checkout.completed', eventsSession());
      expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
      expect(fetchMock.mock.calls[0][1].headers['x-kernel-signature']).toMatch(/^[a-f0-9]{128}$/);
    });
    it('includes transactionId in the checkout.completed payload alongside the session id', async () => {
      await notifyEventsService('checkout.completed', eventsSession());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${EVENTS_URL}/api/webhook/payment`);
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json',
        'x-kernel-signature': expect.stringMatching(/^[a-f0-9]{128}$/) });
      expect(postedBody()).toMatchObject({
        type: 'checkout.completed',
        sessionId: 'cs_test_events_1',
        transactionId: 'tx_abc123',
        paymentId: 'pi_456',
      });
    });

    it('omits transactionId (and still notifies events) when no transaction row is found', async () => {
      mocks.limit.mockResolvedValue([]);

      await notifyEventsService('checkout.completed', eventsSession());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = postedBody();
      expect(body.sessionId).toBe('cs_test_events_1');
      expect(body).not.toHaveProperty('transactionId');
      expect(mocks.log.info).toHaveBeenCalledWith({}, 'Events service notified successfully');
    });

    it('omits transactionId (and still notifies events) when the lookup throws', async () => {
      mocks.limit.mockRejectedValue(new Error('db down'));

      await expect(notifyEventsService('checkout.completed', eventsSession())).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(postedBody()).not.toHaveProperty('transactionId');
    });

    it('#2757: uses the transactionId a BYO settlement already knows, without any platform-rail lookup', async () => {
      await notifyEventsService('checkout.completed', eventsSession({ transactionId: 'tx_byo_1' }));

      expect(mocks.select).not.toHaveBeenCalled();
      expect(postedBody()).toMatchObject({ sessionId: 'cs_test_events_1', transactionId: 'tx_byo_1' });
    });

    it('#2776: forwards the BYO rail marker and the kernel-attested sellerDid top-level', async () => {
      await notifyEventsService(
        'checkout.completed',
        eventsSession({ transactionId: 'tx_byo_1', rail: 'stripe-byo', sellerDid: 'did:imajin:seller' }),
      );

      expect(postedBody()).toMatchObject({
        type: 'checkout.completed',
        sessionId: 'cs_test_events_1',
        transactionId: 'tx_byo_1',
        rail: 'stripe-byo',
        sellerDid: 'did:imajin:seller',
      });
    });

    it('#2776: omits rail and sellerDid for a platform-rail checkout', async () => {
      await notifyEventsService('checkout.completed', eventsSession());

      const body = postedBody();
      expect(body).not.toHaveProperty('rail');
      expect(body).not.toHaveProperty('sellerDid');
    });

    it('#2776: never lets metadata.sellerDid stand in for the attested sellerDid', async () => {
      await notifyEventsService(
        'checkout.completed',
        eventsSession({ metadata: { eventId: 'evt_1', service: 'events', sellerDid: 'did:imajin:spoofed' } }),
      );

      const body = postedBody();
      expect(body).not.toHaveProperty('sellerDid');
      expect(body.metadata.sellerDid).toBe('did:imajin:spoofed');
    });

    it('does not look up a transaction for payment.failed', async () => {
      await notifyEventsService('payment.failed', eventsSession());

      expect(mocks.select).not.toHaveBeenCalled();
      expect(postedBody()).not.toHaveProperty('transactionId');
    });
  });

  it('notifyCheckoutServices passes the transactionId through for an events checkout', async () => {
    await notifyCheckoutServices(eventsSession());

    expect(postedBody().transactionId).toBe('tx_abc123');
  });
});
