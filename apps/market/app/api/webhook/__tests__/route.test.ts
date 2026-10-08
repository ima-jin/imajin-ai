/**
 * Tests for apps/market/app/api/webhook/route.ts (#2740) — a paid purchase
 * updates the listing, publishes listing.purchased, and settles through
 * market's own app token using the checkout recorded at purchase time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.WEBHOOK_SECRET = 'whsec_test';

  const limitMock = vi.fn();
  const whereSelectMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereSelectMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const whereUpdateMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: whereUpdateMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  return {
    limitMock,
    selectMock,
    updateMock,
    setMock,
    publishMock: vi.fn().mockResolvedValue(undefined),
    settleListingPurchaseMock: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('@/db', async () => ({
  db: { select: mocks.selectMock, update: mocks.updateMock },
  listings: (await import('../../../../src/db/schema')).listings,
}));
vi.mock('@imajin/bus', () => ({ publish: mocks.publishMock }));
vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/lib/utils', () => ({
  jsonResponse: (data: unknown, status = 200) => Response.json(data, { status }),
  errorResponse: (error: string, status = 400) => Response.json({ error }, { status }),
}));
vi.mock('@/lib/settle', () => ({ settleListingPurchase: mocks.settleListingPurchaseMock }));
// The real pending-checkout reader: the recorded entry is looked up exactly as in production.
vi.mock('@/lib/pending-checkout', async () => import('../../../../src/lib/pending-checkout'));

import { POST } from '../route';

const LISTING_ID = 'lst_1';
const SESSION_ID = 'cs_test_1';
const SELLER = 'did:imajin:seller';
const BUYER = 'did:imajin:buyer';

const CHAIN = [
  { did: SELLER, role: 'seller', amount: 9.85 },
  { did: 'did:imajin:node', role: 'node', amount: 0.15 },
];
const PENDING = { transactionId: 'tx_abc', amountCents: 1000, chain: CHAIN, at: '2026-10-08T12:00:00.000Z' };
const FAIR_MANIFEST = { version: '1.0', chain: [{ did: SELLER, role: 'seller', share: 1 }] };

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    sellerDid: SELLER,
    status: 'active',
    quantity: 1,
    currency: 'CAD',
    fairManifest: FAIR_MANIFEST,
    metadata: { pendingCheckouts: { [SESSION_ID]: PENDING } },
    ...overrides,
  };
}

function paidBody(overrides: Record<string, unknown> = {}) {
  return {
    type: 'payment.succeeded',
    sessionId: SESSION_ID,
    metadata: { listingId: LISTING_ID, buyerDid: BUYER, amount: 1000, currency: 'CAD' },
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = { 'x-webhook-secret': 'whsec_test' }) {
  return POST(
    new Request('https://market.test/api/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
  );
}

describe('POST /api/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limitMock.mockResolvedValue([listingRow()]);
    mocks.publishMock.mockResolvedValue(undefined);
    mocks.settleListingPurchaseMock.mockResolvedValue(undefined);
  });

  it('rejects a request without the webhook secret', async () => {
    const res = await post(paidBody(), {});
    expect(res.status).toBe(401);
    expect(mocks.settleListingPurchaseMock).not.toHaveBeenCalled();
  });

  it('accepts the secret in the body as well as the header', async () => {
    const res = await post(paidBody({ secret: 'whsec_test' }), {});
    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchaseMock).toHaveBeenCalledTimes(1);
  });

  it('settles a paid purchase with the checkout recorded for its Stripe session', async () => {
    const res = await post(paidBody());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    // Listing updated and the event published, as before.
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'sold' }));
    expect(mocks.publishMock).toHaveBeenCalledWith('listing.purchased', expect.objectContaining({ subject: SELLER, scope: 'market' }));
    // Settlement goes through market's own app token via settleListingPurchase with the recorded checkout.
    expect(mocks.settleListingPurchaseMock).toHaveBeenCalledTimes(1);
    expect(mocks.settleListingPurchaseMock).toHaveBeenCalledWith({
      listingId: LISTING_ID,
      sessionId: SESSION_ID,
      pending: PENDING,
      currency: 'CAD',
      fairManifest: FAIR_MANIFEST,
    });
  });

  it('finds the session id in metadata and defaults the currency from the listing', async () => {
    const body = paidBody({ sessionId: undefined, metadata: { listingId: LISTING_ID, buyerDid: BUYER, sessionId: SESSION_ID } });
    await post(body);

    expect(mocks.settleListingPurchaseMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_ID, currency: 'CAD' }));
  });

  it('falls back to CAD when neither the webhook nor the listing names a currency', async () => {
    mocks.limitMock.mockResolvedValue([listingRow({ currency: null })]);
    await post(paidBody({ metadata: { listingId: LISTING_ID, buyerDid: BUYER } }));

    expect(mocks.settleListingPurchaseMock).toHaveBeenCalledWith(expect.objectContaining({ currency: 'CAD' }));
  });

  it('decrements a multi-quantity listing and still settles', async () => {
    mocks.limitMock.mockResolvedValue([listingRow({ quantity: 3 })]);
    await post(paidBody());

    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2, status: 'active' }));
    expect(mocks.settleListingPurchaseMock).toHaveBeenCalledTimes(1);
  });

  it('marks a depleted multi-quantity listing sold', async () => {
    mocks.limitMock.mockResolvedValue([listingRow({ quantity: 1, status: 'active' })]);
    await post(paidBody());
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'sold' }));
  });

  it('does not settle when the webhook carries no Stripe session id', async () => {
    const res = await post(paidBody({ sessionId: undefined }));

    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchaseMock).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalledWith({ listingId: LISTING_ID }, expect.stringContaining('no Stripe session id'));
  });

  it('does not settle when no checkout was recorded for the session (e.g. a replay after settling)', async () => {
    mocks.limitMock.mockResolvedValue([listingRow({ metadata: { pendingCheckouts: {} } })]);
    const res = await post(paidBody());

    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchaseMock).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalledWith({ listingId: LISTING_ID, sessionId: SESSION_ID }, expect.stringContaining('No recorded checkout'));
  });

  it('skips settlement for a listing without a .fair manifest chain', async () => {
    mocks.limitMock.mockResolvedValue([listingRow({ fairManifest: null })]);
    await post(paidBody());

    expect(mocks.settleListingPurchaseMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith({ listingId: LISTING_ID }, expect.stringContaining('No .fair manifest chain'));

    mocks.limitMock.mockResolvedValue([listingRow({ fairManifest: { version: '1.0', chain: [] } })]);
    await post(paidBody());
    expect(mocks.settleListingPurchaseMock).not.toHaveBeenCalled();
  });

  it('ignores a non-success status', async () => {
    const res = await post({ ...paidBody(), type: 'payment.failed', status: 'failed' });

    expect(res.status).toBe(200);
    expect(mocks.selectMock).not.toHaveBeenCalled();
    expect(mocks.settleListingPurchaseMock).not.toHaveBeenCalled();
  });

  it.each(['paid', 'succeeded'])('treats status "%s" as a successful payment', async (status) => {
    await post({ ...paidBody(), type: undefined, status });
    expect(mocks.settleListingPurchaseMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the webhook has no listing id or the listing no longer exists', async () => {
    await post(paidBody({ metadata: { buyerDid: BUYER } }));
    expect(mocks.selectMock).not.toHaveBeenCalled();

    mocks.limitMock.mockResolvedValue([]);
    const res = await post(paidBody());
    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchaseMock).not.toHaveBeenCalled();
  });

  it('returns 500 when processing fails', async () => {
    mocks.limitMock.mockRejectedValue(new Error('db down'));
    const res = await post(paidBody());

    expect(res.status).toBe(500);
    expect(mocks.log.error).toHaveBeenCalledWith({ err: expect.stringContaining('db down') }, 'Webhook error');
  });

  it('still settles when publishing the bus event fails', async () => {
    mocks.publishMock.mockRejectedValue(new Error('bus down'));
    const res = await post(paidBody());

    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchaseMock).toHaveBeenCalledTimes(1);
  });
});
