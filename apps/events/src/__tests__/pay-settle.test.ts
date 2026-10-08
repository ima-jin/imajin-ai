/**
 * Tests for apps/events/src/lib/pay-settle.ts (#2739).
 *
 * Events settles `order.completed` through the registered-app pay contract:
 * checkout with events' own app-service token + a declared payee manifest,
 * then `POST /pay/api/settle` with the same token. Covers checkout-with-token,
 * settle, the idempotent `alreadySettled` replay, and the 403 a missing
 * `pay:settle` scope earns — including one end-to-end pass against a fake pay
 * service that enforces the kernel's contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@imajin/logger';

const mocks = vi.hoisted(() => {
  const rowQueue: unknown[][] = [];
  const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    const next = rowQueue.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  };
  return {
    rowQueue,
    sqlCalls,
    sqlFn,
    publishMock: vi.fn(),
    getPayAppTokenMock: vi.fn(),
    invalidatePayAppTokenMock: vi.fn(),
  };
});

vi.mock('@imajin/db', () => ({ getClient: () => mocks.sqlFn }));
vi.mock('@imajin/bus', () => ({ publish: mocks.publishMock }));
vi.mock('../lib/pay-app-token', () => ({
  getPayAppToken: mocks.getPayAppTokenMock,
  invalidatePayAppToken: mocks.invalidatePayAppTokenMock,
}));

import {
  buildPayeeManifest,
  chainNeedsBuyerDid,
  hasSettleableChain,
  prepareAppCheckout,
  publishSettlementReceipt,
  settleCompletedOrder,
  settleOrderViaPay,
  type PayeeManifest,
} from '../lib/pay-settle';
import { requestPayCheckoutSession } from '../lib/checkout-helpers';

const PAY_URL = 'https://pay.test/pay';
const ORGANIZER = 'did:imajin:organizer';
const PROTOCOL = 'did:imajin:protocol';
const NODE = 'did:imajin:node';
const BUYER = 'did:imajin:buyer';

const FAIR = {
  fees: [{ role: 'processor', name: 'Processing', rateBps: 290, fixedCents: 30 }],
  chain: [
    { did: ORGANIZER, role: 'seller', share: 0.9 },
    { did: PROTOCOL, role: 'protocol', share: 0.04 },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.0475 },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.0125 },
  ],
};
const FAIR_NO_BUYER = { chain: [{ did: ORGANIZER, role: 'seller', share: 0.96 }, { did: PROTOCOL, role: 'protocol', share: 0.04 }] };

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const logError = log.error as unknown as ReturnType<typeof vi.fn>;
const logWarn = log.warn as unknown as ReturnType<typeof vi.fn>;

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function chainTotal(manifest: PayeeManifest): number {
  return Number.parseFloat(manifest.chain.reduce((sum, entry) => sum + entry.amount, 0).toFixed(2));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rowQueue.length = 0;
  mocks.sqlCalls.length = 0;
  mocks.getPayAppTokenMock.mockResolvedValue('events-app-token');
  mocks.invalidatePayAppTokenMock.mockResolvedValue(undefined);
  mocks.publishMock.mockResolvedValue(undefined);
  process.env.PAY_SERVICE_URL = PAY_URL;
  process.env.NODE_DID = NODE;
  delete process.env.RELAY_IMAJIN_DID;
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

// ─── payee manifest ─────────────────────────────────────────────────────────

describe('buildPayeeManifest', () => {
  it('resolves the share-based chain to dollar amounts that sum to the gross total (no processor-fee deduction)', () => {
    const manifest = buildPayeeManifest({ fairManifest: FAIR, amountCents: 10_000, buyerDid: BUYER });

    expect(manifest).toEqual({
      chain: [
        { did: ORGANIZER, role: 'seller', amount: 90 },
        { did: PROTOCOL, role: 'protocol', amount: 4 },
        { did: NODE, role: 'node', amount: 4.75 },
        { did: BUYER, role: 'buyer_credit', amount: 1.25 },
      ],
    });
    // The manifest's own 2.9% + 30¢ processor fee is NOT netted: the kernel settles the gross payment.
    expect(chainTotal(manifest!)).toBe(100);
  });

  it('keeps the chain summing to the total across awkward amounts (rounding drift)', () => {
    for (const cents of [1, 99, 333, 1_999, 12_345]) {
      const manifest = buildPayeeManifest({ fairManifest: FAIR, amountCents: cents, buyerDid: BUYER })!;
      expect(chainTotal(manifest)).toBe(Number.parseFloat((cents / 100).toFixed(2)));
    }
  });

  it('falls back to RELAY_IMAJIN_DID for the node DID', () => {
    delete process.env.NODE_DID;
    process.env.RELAY_IMAJIN_DID = 'did:imajin:relay';

    const manifest = buildPayeeManifest({ fairManifest: FAIR, amountCents: 10_000, buyerDid: BUYER })!;

    expect(manifest.chain.find((e) => e.role === 'node')?.did).toBe('did:imajin:relay');
  });

  it('returns null when the event manifest has no chain', () => {
    expect(buildPayeeManifest({ fairManifest: null, amountCents: 1000 })).toBeNull();
    expect(buildPayeeManifest({ fairManifest: { chain: [] }, amountCents: 1000 })).toBeNull();
    expect(buildPayeeManifest({ fairManifest: { fees: [] }, amountCents: 1000 })).toBeNull();
  });
});

describe('chain predicates', () => {
  it('hasSettleableChain / chainNeedsBuyerDid read the .fair chain', () => {
    expect(hasSettleableChain(FAIR)).toBe(true);
    expect(hasSettleableChain(null)).toBe(false);
    expect(hasSettleableChain({ chain: [] })).toBe(false);
    expect(chainNeedsBuyerDid(FAIR)).toBe(true);
    expect(chainNeedsBuyerDid(FAIR_NO_BUYER)).toBe(false);
    expect(chainNeedsBuyerDid(null)).toBe(false);
  });
});

// ─── checkout ───────────────────────────────────────────────────────────────

describe('prepareAppCheckout', () => {
  const resolveSoftDid = vi.fn();

  beforeEach(() => {
    resolveSoftDid.mockReset();
    resolveSoftDid.mockResolvedValue('did:imajin:soft-buyer');
  });

  it('mints events’ app token and declares the payee manifest for a signed-in buyer', async () => {
    const result = await prepareAppCheckout({ fairManifest: FAIR, amountCents: 10_000, buyerDid: BUYER, resolveSoftDid, log });

    expect(result).toEqual({
      appAuth: {
        bearer: 'events-app-token',
        payeeManifest: buildPayeeManifest({ fairManifest: FAIR, amountCents: 10_000, buyerDid: BUYER }),
      },
    });
    expect(resolveSoftDid).not.toHaveBeenCalled();
  });

  it('resolves a soft DID from the email for an anonymous buyer when the chain pays the buyer', async () => {
    const result = await prepareAppCheckout({ fairManifest: FAIR, amountCents: 10_000, email: 'a@b.test', resolveSoftDid, log });

    expect(resolveSoftDid).toHaveBeenCalledWith('a@b.test');
    expect(result).toMatchObject({ appAuth: { payeeManifest: { chain: expect.arrayContaining([{ did: 'did:imajin:soft-buyer', role: 'buyer_credit', amount: 1.25 }]) } } });
  });

  it('does not need a buyer at all when the chain has no buyer entry', async () => {
    const result = await prepareAppCheckout({ fairManifest: FAIR_NO_BUYER, amountCents: 5_000, resolveSoftDid, log });

    expect(resolveSoftDid).not.toHaveBeenCalled();
    expect(result).toMatchObject({ appAuth: { bearer: 'events-app-token' } });
  });

  it('is not app-bound (and warns) for an event with no .fair chain', async () => {
    const result = await prepareAppCheckout({ fairManifest: null, amountCents: 5_000, resolveSoftDid, log });

    expect(result).toEqual({ appAuth: null });
    expect(mocks.getPayAppTokenMock).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalled();
  });

  it('400s when the chain pays the buyer but neither a session nor an email identifies them', async () => {
    const result = await prepareAppCheckout({ fairManifest: FAIR, amountCents: 10_000, resolveSoftDid, log });

    expect(result).toEqual({ error: 'An email address is required to check out for this event', status: 400 });
    expect(mocks.getPayAppTokenMock).not.toHaveBeenCalled();
  });

  it('500s when the buyer’s soft DID cannot be resolved', async () => {
    resolveSoftDid.mockRejectedValue(new Error('auth down'));

    const result = await prepareAppCheckout({ fairManifest: FAIR, amountCents: 10_000, email: 'a@b.test', resolveSoftDid, log });

    expect(result).toEqual({ error: 'Checkout failed', status: 500 });
    expect(logError).toHaveBeenCalled();
  });

  it('fails closed (503) when events cannot obtain its app token', async () => {
    mocks.getPayAppTokenMock.mockRejectedValue(new Error('loadAppSigningKey: no keystore found'));

    const result = await prepareAppCheckout({ fairManifest: FAIR, amountCents: 10_000, buyerDid: BUYER, resolveSoftDid, log });

    expect(result).toEqual({ error: 'Payment service unavailable', status: 503 });
    expect(logError).toHaveBeenCalled();
  });
});

describe('requestPayCheckoutSession with app auth', () => {
  const base = {
    payServiceUrl: PAY_URL,
    items: [{ name: 'GA', amount: 10_000, quantity: 1 }],
    currency: 'CAD',
    successUrl: 'https://events.test/ok',
    cancelUrl: 'https://events.test/cancel',
    fairManifest: FAIR,
    sellerDid: ORGANIZER,
    metadata: { service: 'events' },
    log,
  };

  it('sends the app token as Authorization: Bearer and the declared payeeManifest', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'cs_1', url: 'https://stripe.test/cs_1', transactionId: 'tx_1' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const payeeManifest = buildPayeeManifest({ fairManifest: FAIR, amountCents: 10_000, buyerDid: BUYER })!;

    const result = await requestPayCheckoutSession({ ...base, appAuth: { bearer: 'events-app-token', payeeManifest } });

    expect(result).toMatchObject({ checkout: { id: 'cs_1' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${PAY_URL}/api/checkout`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer events-app-token');
    const body = JSON.parse(init.body as string);
    expect(body.payeeManifest).toEqual(payeeManifest);
    expect(body.fairManifest).toEqual(FAIR);
    expect(body.appAuth).toBeUndefined();
  });

  it('sends no Authorization header and no payeeManifest without app auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'cs_2', url: 'https://stripe.test/cs_2' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await requestPayCheckoutSession({ ...base, appAuth: null });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string).payeeManifest).toBeUndefined();
  });
});

// ─── settle ─────────────────────────────────────────────────────────────────

const MANIFEST: PayeeManifest = buildPayeeManifest({ fairManifest: FAIR, amountCents: 10_000, buyerDid: BUYER })!;
const SETTLE_META = { orderId: 'ord_1', ticketIds: ['tkt_1'], stripeSessionId: 'cs_1', eventId: 'evt_1' };

function recordPayment(manifest: unknown = MANIFEST) {
  mocks.rowQueue.push([{ id: 'tx_1', payee_manifest: manifest }]);
}

function lastSettleRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> };
}

describe('settleOrderViaPay', () => {
  it('settles with events’ app token: transaction_id from checkout + the recorded fair_manifest', async () => {
    recordPayment();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ settled: true, batchId: 'batch_1', transactions: ['t1'], total_amount: 100, recipients: 4, source: 'external' }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log });

    expect(outcome).toEqual({ status: 'settled', alreadySettled: false, batchId: 'batch_1', manifest: MANIFEST });
    const { url, headers, body } = lastSettleRequest(fetchMock);
    expect(url).toBe(`${PAY_URL}/api/settle`);
    expect(headers.Authorization).toBe('Bearer events-app-token');
    expect(body).toEqual({ transaction_id: 'tx_1', fair_manifest: MANIFEST, metadata: SETTLE_META });
    // The settle path never sends the shared key.
    expect(JSON.stringify(headers)).not.toMatch(/service-key|PAY_SERVICE_API_KEY/);
    // The payment is looked up by Stripe session id on the stripe rail, and only app-bound rows count.
    expect(mocks.sqlCalls[0]!.text).toContain("rail = 'stripe' AND external_ref = ?");
    expect(mocks.sqlCalls[0]!.text).toContain('app_did IS NOT NULL');
    expect(mocks.sqlCalls[0]!.values).toEqual(['cs_1']);
  });

  it('treats alreadySettled: true as success (idempotent replay)', async () => {
    recordPayment();
    globalThis.fetch = vi.fn(async () => jsonResponse({ settled: true, batchId: 'batch_1', alreadySettled: true })) as unknown as typeof fetch;

    const outcome = await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log });

    expect(outcome).toMatchObject({ status: 'settled', alreadySettled: true, batchId: 'batch_1' });
    expect(logError).not.toHaveBeenCalled();
  });

  it('403 when pay:settle is not granted → failed outcome, logged, no throw', async () => {
    recordPayment();
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "Forbidden - scope 'pay:settle' was not granted" }, 403)) as unknown as typeof fetch;

    const outcome = await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log });

    expect(outcome).toEqual({ status: 'failed', httpStatus: 403, error: "Forbidden - scope 'pay:settle' was not granted" });
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ status: 403, transactionId: 'tx_1' }), expect.any(String));
    // Neither the token nor any secret reaches the logs.
    expect(JSON.stringify(logError.mock.calls)).not.toContain('events-app-token');
  });

  it('refreshes the token once on a 401 and retries', async () => {
    recordPayment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized - invalid or expired app-service token' }, 401))
      .mockResolvedValueOnce(jsonResponse({ settled: true, batchId: 'batch_2' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mocks.getPayAppTokenMock.mockResolvedValueOnce('stale-token').mockResolvedValueOnce('fresh-token');

    const outcome = await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log });

    expect(outcome).toMatchObject({ status: 'settled', batchId: 'batch_2' });
    expect(mocks.invalidatePayAppTokenMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer fresh-token' });
  });

  it('gives up after one 401 retry', async () => {
    recordPayment();
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, 401));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log });

    expect(outcome).toMatchObject({ status: 'failed', httpStatus: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('survives a failed token invalidation on the 401 path', async () => {
    recordPayment();
    mocks.invalidatePayAppTokenMock.mockRejectedValue(new Error('provider gone'));
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ settled: true })) as unknown as typeof fetch;

    expect(await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log })).toMatchObject({ status: 'settled' });
  });

  it('reports other kernel refusals (409 not yet paid, 404, 5xx) as failed with the kernel’s reason', async () => {
    recordPayment();
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "Payment is not paid yet (status 'pending')" }, 409)) as unknown as typeof fetch;
    expect(await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log })).toEqual({
      status: 'failed',
      httpStatus: 409,
      error: "Payment is not paid yet (status 'pending')",
    });

    recordPayment();
    globalThis.fetch = vi.fn(async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    expect(await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log })).toEqual({
      status: 'failed',
      httpStatus: 502,
      error: 'status 502',
    });
  });

  it('skips (no settle call) when no app-bound payment is recorded for the session', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await settleOrderViaPay({ sessionId: 'cs_legacy', metadata: SETTLE_META, log });

    expect(outcome).toEqual({ status: 'skipped', reason: 'no app-bound payment recorded for session' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalled();
  });

  it.each([
    ['a null payee manifest', null],
    ['a manifest without a chain', {}],
    ['an empty chain', { chain: [] }],
  ])('skips when the recorded payment has %s', async (_label, manifest) => {
    recordPayment(manifest);
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    expect(await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log })).toMatchObject({ status: 'skipped' });
  });

  it('fails (without throwing) when the recorded-payment lookup errors', async () => {
    mocks.rowQueue.push(new Error('column "app_did" does not exist') as unknown as unknown[]);

    const outcome = await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log });

    expect(outcome).toEqual({ status: 'failed', error: 'recorded payment lookup failed' });
    expect(logError).toHaveBeenCalled();
  });

  it('fails when events cannot obtain its app token', async () => {
    recordPayment();
    mocks.getPayAppTokenMock.mockRejectedValue(new Error('no keystore'));
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const outcome = await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log });

    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringContaining('app-service token unavailable') });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fails when the pay service is unreachable', async () => {
    recordPayment();
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    expect(await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log })).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('pay service unreachable'),
    });
  });

  it('fails when PAY_SERVICE_URL is not configured', async () => {
    recordPayment();
    delete process.env.PAY_SERVICE_URL;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    expect(await settleOrderViaPay({ sessionId: 'cs_1', metadata: SETTLE_META, log })).toEqual({
      status: 'failed',
      error: 'PAY_SERVICE_URL is not set',
      httpStatus: undefined,
    });
  });
});

// ─── receipt + orchestration ────────────────────────────────────────────────

const ORDER = {
  sessionId: 'cs_1',
  orderId: 'ord_1',
  eventId: 'evt_1',
  buyerDid: BUYER,
  creatorDid: ORGANIZER,
  amountCents: 10_000,
  currency: 'CAD',
  fairManifest: FAIR,
  metadata: SETTLE_META,
  log,
};

describe('settleCompletedOrder', () => {
  it('settles, then publishes settlement.completed with the settled chain and estimated fees', async () => {
    recordPayment();
    globalThis.fetch = vi.fn(async () => jsonResponse({ settled: true, batchId: 'batch_1' })) as unknown as typeof fetch;

    const outcome = await settleCompletedOrder(ORDER);

    expect(outcome).toMatchObject({ status: 'settled' });
    expect(mocks.publishMock).toHaveBeenCalledTimes(1);
    const [type, event] = mocks.publishMock.mock.calls[0]!;
    expect(type).toBe('settlement.completed');
    expect(event).toMatchObject({ issuer: BUYER, subject: ORGANIZER, scope: 'events' });
    expect(event.payload).toMatchObject({
      orderId: 'ord_1',
      eventId: 'evt_1',
      buyerDid: BUYER,
      amount: 10_000,
      currency: 'CAD',
      totalAmount: 100,
      netAmount: 100,
      chain: MANIFEST.chain,
      metadata: SETTLE_META,
      fees: [{ role: 'processor', name: 'Processing', rateBps: 290, fixedCents: 30, amount: 3.2, estimated: true }],
    });
  });

  it('also announces the receipt on an alreadySettled replay', async () => {
    recordPayment();
    globalThis.fetch = vi.fn(async () => jsonResponse({ settled: true, alreadySettled: true })) as unknown as typeof fetch;

    expect(await settleCompletedOrder(ORDER)).toMatchObject({ status: 'settled', alreadySettled: true });
    expect(mocks.publishMock).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing when settlement failed or was skipped', async () => {
    recordPayment();
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'Forbidden' }, 403)) as unknown as typeof fetch;
    expect(await settleCompletedOrder(ORDER)).toMatchObject({ status: 'failed' });

    expect(await settleCompletedOrder(ORDER)).toMatchObject({ status: 'skipped' });
    expect(mocks.publishMock).not.toHaveBeenCalled();
  });
});

describe('publishSettlementReceipt', () => {
  const receipt = { ...ORDER, manifest: MANIFEST };

  it('reports no fees for a manifest without fee entries', async () => {
    await publishSettlementReceipt({ ...receipt, fairManifest: FAIR_NO_BUYER }, log);

    expect(mocks.publishMock.mock.calls[0]![1].payload.fees).toEqual([]);
  });

  it('is non-fatal when the bus publish fails', async () => {
    mocks.publishMock.mockRejectedValue(new Error('bus down'));

    await expect(publishSettlementReceipt(receipt, log)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });
});

// ─── end to end against a fake pay service ──────────────────────────────────

/**
 * A fake pay service that enforces the registered-app contract the kernel (#2695) does:
 * an app-service token with `pay:settle` is required on checkout and settle; the payment is
 * bound to the calling app; the posted chain must equal the recorded payee manifest; a second
 * settle replays the first (`alreadySettled`).
 */
function fakePayService(tokenScopes: Record<string, string[]>) {
  const payments = new Map<string, { appToken: string; payeeManifest: unknown; settleBatch?: string }>();
  let nextTx = 1;

  const handler = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>;
    const token = headers.Authorization?.replace('Bearer ', '');
    const body = JSON.parse(init.body as string);
    if (!token || !(token in tokenScopes)) return jsonResponse({ error: 'Unauthorized - invalid or expired app-service token' }, 401);
    if (!tokenScopes[token]!.includes('pay:settle')) return jsonResponse({ error: "Forbidden - scope 'pay:settle' was not granted" }, 403);

    if (url.endsWith('/api/checkout')) {
      const transactionId = `tx_${nextTx++}`;
      payments.set(transactionId, { appToken: token, payeeManifest: body.payeeManifest });
      return jsonResponse({ id: `cs_${transactionId}`, url: 'https://stripe.test/pay', transactionId });
    }

    const payment = payments.get(body.transaction_id);
    if (!payment) return jsonResponse({ error: 'Payment not found' }, 404);
    if (payment.appToken !== token) return jsonResponse({ error: 'Forbidden - payment was not created by this app' }, 403);
    if (payment.settleBatch) return jsonResponse({ settled: true, batchId: payment.settleBatch, alreadySettled: true });
    if (JSON.stringify(payment.payeeManifest) !== JSON.stringify(body.fair_manifest)) {
      return jsonResponse({ error: 'fair_manifest does not match the recorded payee manifest' }, 403);
    }
    payment.settleBatch = `batch_${body.transaction_id}`;
    return jsonResponse({ settled: true, batchId: payment.settleBatch });
  };

  return { payments, fetch: vi.fn(handler) };
}

describe('end to end: checkout with the app token, then settle', () => {
  async function checkoutAndPay(pay: ReturnType<typeof fakePayService>, token: string) {
    mocks.getPayAppTokenMock.mockResolvedValue(token);
    globalThis.fetch = pay.fetch as unknown as typeof fetch;

    const prepared = await prepareAppCheckout({ fairManifest: FAIR, amountCents: 10_000, buyerDid: BUYER, resolveSoftDid: vi.fn(), log });
    if ('error' in prepared) throw new Error(prepared.error);
    const checkout = await requestPayCheckoutSession({
      payServiceUrl: PAY_URL,
      items: [{ name: 'GA', amount: 10_000, quantity: 1 }],
      currency: 'CAD',
      successUrl: 'https://events.test/ok',
      cancelUrl: 'https://events.test/cancel',
      fairManifest: FAIR,
      sellerDid: ORGANIZER,
      metadata: { service: 'events' },
      appAuth: prepared.appAuth,
      log,
    });
    return { prepared, checkout };
  }

  it('a paid ticket settles via /pay/api/settle; replaying the webhook is idempotent', async () => {
    const pay = fakePayService({ 'events-app-token': ['pay:settle'] });
    const { checkout } = await checkoutAndPay(pay, 'events-app-token');
    expect(checkout).toMatchObject({ checkout: { id: 'cs_tx_1' } });
    const recorded = pay.payments.get('tx_1')!;
    mocks.rowQueue.push([{ id: 'tx_1', payee_manifest: recorded.payeeManifest }]);
    mocks.rowQueue.push([{ id: 'tx_1', payee_manifest: recorded.payeeManifest }]);

    const first = await settleCompletedOrder({ ...ORDER, sessionId: 'cs_tx_1' });
    const replay = await settleCompletedOrder({ ...ORDER, sessionId: 'cs_tx_1' });

    expect(first).toMatchObject({ status: 'settled', alreadySettled: false, batchId: 'batch_tx_1' });
    expect(replay).toMatchObject({ status: 'settled', alreadySettled: true, batchId: 'batch_tx_1' });
    expect(logError).not.toHaveBeenCalled();
  });

  it('403 when the app token lacks pay:settle: checkout is refused, so no unsettleable payment is taken', async () => {
    const pay = fakePayService({ 'no-scope-token': ['profile:read'] });

    const { checkout } = await checkoutAndPay(pay, 'no-scope-token');

    expect(checkout).toEqual({ error: "Forbidden - scope 'pay:settle' was not granted", status: 500 });
    expect(pay.payments.size).toBe(0);
  });

  it('403 at settle when the token has lost pay:settle since checkout', async () => {
    const scopes: Record<string, string[]> = { 'events-app-token': ['pay:settle'] };
    const pay = fakePayService(scopes);
    await checkoutAndPay(pay, 'events-app-token');
    mocks.rowQueue.push([{ id: 'tx_1', payee_manifest: pay.payments.get('tx_1')!.payeeManifest }]);
    scopes['events-app-token'] = [];

    const outcome = await settleOrderViaPay({ sessionId: 'cs_tx_1', metadata: SETTLE_META, log });

    expect(outcome).toEqual({ status: 'failed', httpStatus: 403, error: "Forbidden - scope 'pay:settle' was not granted" });
  });
});
