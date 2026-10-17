/**
 * Tests for the learn notification in apps/kernel/src/lib/pay/webhook-handlers.ts (ima-jin/learn#13).
 *
 * Learn creates a paid enrollment from the kernel's notification: an authenticated server-to-server
 * `POST {registered learn URL}/api/webhook` (using published-key kernel signatures) naming the
 * Stripe session, with `rail: "stripe-byo"` top-level for a payment the kernel settled on the
 * seller's own Stripe account (#2773). A learn outage must never fail the Stripe webhook ack.
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

import { notifyCheckoutServices, notifyLearnService } from '../webhook-handlers';
import type { StripeCheckoutSessionLike } from '../webhook-event-shapes';

const LEARN_URL = 'https://learn.test/learn';
const MARKET_URL = 'https://market.test/market';

const fetchMock = vi.fn();

function learnSession(overrides: Partial<StripeCheckoutSessionLike> = {}): StripeCheckoutSessionLike {
  return {
    id: 'cs_test_learn_1',
    amount_total: 4900,
    currency: 'cad',
    payment_intent: 'pi_learn_1',
    metadata: {
      service: 'learn',
      source: 'learn',
      courseId: 'crs_1',
      studentDid: 'did:imajin:student',
    },
    ...overrides,
  };
}

const learnCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(LEARN_URL));

function sentBody(): Record<string, unknown> {
  return JSON.parse((learnCalls()[0]![1] as RequestInit).body as string);
}

describe('learn enrollment notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_PRIVATE_KEY', authCrypto.generatePrivateKey());
    vi.stubGlobal('fetch', fetchMock);
    mocks.resolveRegistryAppBaseUrl.mockImplementation(async (slug: string) => slug === 'learn' ? LEARN_URL : MARKET_URL);
    fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ received: true }), { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('notifyCheckoutServices', () => {
    it("a learn checkout triggers an authenticated call to learn's /api/webhook with the session id", async () => {
      await notifyCheckoutServices(learnSession());

      expect(learnCalls()).toHaveLength(1);
      const [url, init] = learnCalls()[0] as [string, RequestInit];
      expect(url).toBe(`${LEARN_URL}/api/webhook`);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json',
        'x-kernel-signature': expect.stringMatching(/^[a-f0-9]{128}$/) });

      expect(sentBody()).toEqual({
        type: 'payment.succeeded',
        sessionId: 'cs_test_learn_1',
        paymentId: 'pi_learn_1',
        metadata: {
          service: 'learn',
          source: 'learn',
          courseId: 'crs_1',
          studentDid: 'did:imajin:student',
          amount: 4900,
          currency: 'CAD',
        },
      });
      expect(mocks.log.info).toHaveBeenCalledWith({ sessionId: 'cs_test_learn_1' }, 'Learn service notified successfully');
    });

    it('recognises a checkout started before learn tagged service (source: learn only)', async () => {
      await notifyCheckoutServices(
        learnSession({ metadata: { source: 'learn', courseId: 'crs_1', studentDid: 'did:imajin:student' } }),
      );

      expect(learnCalls()).toHaveLength(1);
    });

    it('a learn checkout does not call market', async () => {
      await notifyCheckoutServices(learnSession());

      expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith(MARKET_URL))).toHaveLength(0);
      expect(mocks.publishMock).not.toHaveBeenCalled();
    });

    it('a non-learn session does not call learn', async () => {
      await notifyCheckoutServices(learnSession({ metadata: { service: 'coffee', sellerDid: 'did:imajin:seller' } }));
      await notifyCheckoutServices(learnSession({ metadata: { service: 'market', source: 'market' } }));
      await notifyCheckoutServices(learnSession({ metadata: null }));
      await notifyCheckoutServices(learnSession({ metadata: undefined }));

      expect(learnCalls()).toHaveLength(0);
    });

    it('a learn 5xx is logged and does not fail the Stripe webhook ack', async () => {
      fetchMock.mockImplementation(async () => new Response('upstream exploded', { status: 503 }));

      await expect(notifyCheckoutServices(learnSession())).resolves.toBeUndefined();

      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_test_learn_1', status: 503, error: 'upstream exploded' },
        'Learn service webhook failed',
      );
    });

    it('fails soft when registry discovery throws', async () => {
      mocks.resolveRegistryAppBaseUrl.mockRejectedValue(new Error('registry down'));
      await expect(notifyLearnService(learnSession())).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_test_learn_1', err: expect.stringContaining('registry down') },
        'Failed to notify learn service',
      );
    });

    it('uses the registered URL even when a stale environment URL is set', async () => {
      vi.stubEnv('LEARN_SERVICE_URL', 'https://stale-learn.test');
      await notifyLearnService(learnSession());
      expect(mocks.resolveRegistryAppBaseUrl).toHaveBeenCalledWith('learn');
      expect(learnCalls()).toHaveLength(1);
    });

    it('delivers with a kernel signature when no legacy secret is configured', async () => {
      await notifyLearnService(learnSession());
      const headers = learnCalls()[0][1].headers;
      expect(headers).not.toHaveProperty('Authorization');
      expect(headers['x-kernel-signature']).toMatch(/^[a-f0-9]{128}$/);
    });

    it('a learn 401 (signature rejection) is logged and does not fail the ack either', async () => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));

      await expect(notifyCheckoutServices(learnSession())).resolves.toBeUndefined();

      expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }), 'Learn service webhook failed');
    });

    it('a network failure reaching learn is logged and does not fail the ack', async () => {
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(notifyCheckoutServices(learnSession())).resolves.toBeUndefined();

      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_test_learn_1', err: expect.stringContaining('ECONNREFUSED') },
        'Failed to notify learn service',
      );
    });
  });

  describe('notifyLearnService', () => {
    it("forwards the rail of a payment the kernel already settled on the seller's own Stripe account (#2773)", async () => {
      await notifyLearnService(learnSession({ rail: 'stripe-byo' }));
      expect(sentBody().rail).toBe('stripe-byo');
    });

    it('sends no rail for a platform-collected payment', async () => {
      await notifyLearnService(learnSession());
      expect(sentBody()).not.toHaveProperty('rail');
    });

    it('forwards the kernel-attested seller DID top-level, apart from caller-supplied metadata', async () => {
      await notifyLearnService(
        learnSession({
          rail: 'stripe-byo',
          sellerDid: 'did:imajin:creator',
          metadata: { service: 'learn', courseId: 'crs_1', sellerDid: 'did:imajin:forged' },
        }),
      );

      const body = sentBody() as { sellerDid: string; metadata: { sellerDid: string } };
      expect(body.sellerDid).toBe('did:imajin:creator');
      expect(body.metadata.sellerDid).toBe('did:imajin:forged');
    });

    it('sends no top-level seller DID when the session carries none', async () => {
      await notifyLearnService(learnSession());
      expect(sentBody()).not.toHaveProperty('sellerDid');
    });

    it('reads the payment intent id from an expanded payment_intent object', async () => {
      await notifyLearnService(learnSession({ payment_intent: { id: 'pi_expanded' } }));
      expect(sentBody().paymentId).toBe('pi_expanded');
    });

    it('omits the payment id and currency when the session has none', async () => {
      await notifyLearnService(learnSession({ payment_intent: null, currency: null }));

      const body = sentBody() as { paymentId?: string; metadata: { currency?: string } };
      expect(body.paymentId).toBeUndefined();
      expect(body.metadata.currency).toBeUndefined();
    });

    it('does not call out, and logs loudly, when the registry URL is missing', async () => {
      mocks.resolveRegistryAppBaseUrl.mockResolvedValue(null);

      await expect(notifyLearnService(learnSession())).resolves.toBeUndefined();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.log.error).toHaveBeenCalledWith(
        { sessionId: 'cs_test_learn_1' },
        'Learn registry URL unavailable — learn enrollment will not be created',
      );
    });
  });
});
