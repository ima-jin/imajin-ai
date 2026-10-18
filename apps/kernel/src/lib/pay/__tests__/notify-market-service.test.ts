/**
 * Tests for the market notification in apps/kernel/src/lib/pay/webhook-handlers.ts (#2740).
 *
 * Market settles its own purchases through `/pay/api/settle` with its app-service token, so the
 * kernel's Stripe webhook must tell market a purchase was paid: an authenticated server-to-server
 * `POST {registered market URL}/api/webhook` (using published-key kernel signatures) naming
 * the Stripe session. A market outage must never fail the Stripe webhook ack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
vi.mock('../../auth/kernel-webhook-recipient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../auth/kernel-webhook-recipient')>(),
  resolveKernelWebhookAudience: vi.fn(async (_url, recipient) => `did:imajin:${recipient.appSlug}`),
}));

const mocks = vi.hoisted(() => ({
  publishMock: vi.fn().mockResolvedValue(undefined),
  resolveRegistryAppBaseUrl: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/src/lib/apps/registry-url', () => ({
  resolveRegistryAppBaseUrl: mocks.resolveRegistryAppBaseUrl,
}));
vi.mock('@/src/db', () => ({
  db: {},
  feeLedger: {},
  balances: {},
  balanceRollups: {},
  transactions: {},
}));
vi.mock('drizzle-orm', () => ({ sql: vi.fn(), eq: vi.fn() }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@imajin/bus', () => ({ publish: mocks.publishMock }));
vi.mock('@imajin/fair', () => ({ processorFeeCents: () => 0 }));
vi.mock('../providers/stripe-webhook', () => ({ fetchActualFee: vi.fn() }));
vi.mock('../checkout-notification-owner', () => ({
  checkoutAppSlug: async (session: { metadata?: { service?: string } }) => session.metadata?.service,
}));

import { notifyCheckoutServices, notifyMarketService } from '../webhook-handlers';
import type { StripeCheckoutSessionLike } from '../webhook-event-shapes';

const MARKET_URL = 'https://market.test/market';
const EVENTS_URL = 'https://events.test';

const fetchMock = vi.fn();

function marketSession(overrides: Partial<StripeCheckoutSessionLike> = {}): StripeCheckoutSessionLike {
  return {
    id: 'cs_test_market_1',
    amount_total: 2500,
    currency: 'cad',
    payment_intent: 'pi_123',
    customer_email: 'buyer@example.com',
    metadata: {
      service: 'market',
      listingId: 'lst_1',
      listingTitle: 'Vintage Chair',
      sellerDid: 'did:imajin:seller',
      buyerDid: 'did:imajin:buyer',
    },
    ...overrides,
  };
}

const marketCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(MARKET_URL));

describe('market purchase notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_PRIVATE_KEY', authCrypto.generatePrivateKey());
    vi.stubGlobal('fetch', fetchMock);
    mocks.resolveRegistryAppBaseUrl.mockImplementation(async (slug: string) => slug === 'market' ? MARKET_URL : EVENTS_URL);
    mocks.publishMock.mockResolvedValue(undefined);
    fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ received: true }), { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('notifyCheckoutServices', () => {
    it("a market purchase triggers an authenticated call to market's /api/webhook with the session id", async () => {
      await notifyCheckoutServices(marketSession());

      expect(marketCalls()).toHaveLength(1);
      const [url, init] = marketCalls()[0] as [string, RequestInit];
      expect(url).toBe(`${MARKET_URL}/api/webhook`);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json',
        'x-kernel-signature': expect.stringMatching(/^[a-f0-9]{128}$/) });

      expect(JSON.parse(init.body as string)).toEqual({
        type: 'payment.succeeded',
        sessionId: 'cs_test_market_1',
        paymentId: 'pi_123',
        metadata: {
          service: 'market',
          listingId: 'lst_1',
          listingTitle: 'Vintage Chair',
          sellerDid: 'did:imajin:seller',
          buyerDid: 'did:imajin:buyer',
          amount: 2500,
          currency: 'CAD',
        },
      });
      expect(mocks.log.info).toHaveBeenCalledWith({ sessionId: 'cs_test_market_1' }, 'Market service notified successfully');
    });

    it('still publishes the market.sale / market.purchase notifications', async () => {
      await notifyCheckoutServices(marketSession());

      const topics = mocks.publishMock.mock.calls.map(([topic]) => topic);
      expect(topics).toEqual(['market.sale', 'market.purchase']);
    });

    it('a non-market session does not call market', async () => {
      await notifyCheckoutServices(marketSession({ metadata: { service: 'coffee', sellerDid: 'did:imajin:seller' } }));
      await notifyCheckoutServices(marketSession({ metadata: { service: 'events' } }));
      await notifyCheckoutServices(marketSession({ metadata: null }));
      await notifyCheckoutServices(marketSession({ metadata: undefined }));

      expect(marketCalls()).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('an events checkout still notifies events and not market', async () => {
      await notifyCheckoutServices(marketSession({ metadata: { eventId: 'evt_1', service: 'events' } }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toBe(`${EVENTS_URL}/api/webhook/payment`);
      expect(marketCalls()).toHaveLength(0);
    });

    it('notifies market for a market session that has no seller DID (settlement does not depend on it)', async () => {
      await notifyCheckoutServices(marketSession({ metadata: { service: 'market', listingId: 'lst_1' } }));

      expect(marketCalls()).toHaveLength(1);
      expect(mocks.publishMock).not.toHaveBeenCalled();
    });

    it('a market 5xx is logged and does not fail the Stripe webhook ack', async () => {
      fetchMock.mockImplementation(async () => new Response('upstream exploded', { status: 503 }));

      await expect(notifyCheckoutServices(marketSession())).resolves.toBeUndefined();

      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_test_market_1', status: 503, error: 'upstream exploded' },
        'Market service webhook failed',
      );
    });

    it('a market 401 (signature rejection) is logged and does not fail the ack either', async () => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));

      await expect(notifyCheckoutServices(marketSession())).resolves.toBeUndefined();

      expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }), 'Market service webhook failed');
    });

    it('a network failure reaching market is logged and does not fail the ack', async () => {
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(notifyCheckoutServices(marketSession())).resolves.toBeUndefined();

      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_test_market_1', err: expect.stringContaining('ECONNREFUSED') },
        'Failed to notify market service',
      );
    });
  });

  describe('notifyMarketService', () => {
    it('reads the payment intent id from an expanded payment_intent object', async () => {
      await notifyMarketService(marketSession({ payment_intent: { id: 'pi_expanded' } }));
      expect(JSON.parse((marketCalls()[0]![1] as RequestInit).body as string).paymentId).toBe('pi_expanded');
    });

    it('forwards the rail of a payment the kernel already settled on the seller\'s own Stripe account (#2773)', async () => {
      await notifyMarketService(marketSession({ rail: 'stripe-byo' }));
      expect(JSON.parse((marketCalls()[0]![1] as RequestInit).body as string).rail).toBe('stripe-byo');
    });

    it('sends no rail for a platform-collected payment (#2773)', async () => {
      await notifyMarketService(marketSession());
      expect(JSON.parse((marketCalls()[0]![1] as RequestInit).body as string)).not.toHaveProperty('rail');
    });

    it('omits the payment id and currency when the session has none', async () => {
      await notifyMarketService(marketSession({ payment_intent: null, currency: null }));

      const body = JSON.parse((marketCalls()[0]![1] as RequestInit).body as string);
      expect(body.paymentId).toBeUndefined();
      expect(body.metadata.currency).toBeUndefined();
    });

    it('does not call out, and logs loudly, when the registry URL is missing', async () => {
      mocks.resolveRegistryAppBaseUrl.mockResolvedValue(null);

      await expect(notifyMarketService(marketSession())).resolves.toBeUndefined();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_test_market_1' },
        expect.stringContaining('market purchase will not settle'),
      );
    });

    it('fails soft when registry discovery throws', async () => {
      mocks.resolveRegistryAppBaseUrl.mockRejectedValue(new Error('registry down'));
      await expect(notifyMarketService(marketSession())).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_test_market_1', err: expect.stringContaining('registry down') },
        'Failed to notify market service',
      );
    });

    it('uses the registered URL even when a stale environment URL is set', async () => {
      vi.stubEnv('MARKET_SERVICE_URL', 'https://stale-market.test');
      await notifyMarketService(marketSession());
      expect(mocks.resolveRegistryAppBaseUrl).toHaveBeenCalledWith('market');
      expect(marketCalls()).toHaveLength(1);
    });

    it('delivers with a kernel signature when no legacy secret is configured', async () => {
      await notifyMarketService(marketSession());
      const headers = marketCalls()[0][1].headers;
      expect(headers).not.toHaveProperty('Authorization');
      expect(headers['x-kernel-signature']).toMatch(/^[a-f0-9]{128}$/);
    });
  });
});
