/**
 * Tests for apps/market/app/api/listings/[id]/purchase/route.ts (#2740) —
 * a listing with a .fair chain checks out with market's OWN app-service token
 * and a `payeeManifest`, and the resulting kernel payment is remembered so the
 * purchase webhook can settle it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.PAY_SERVICE_URL = 'https://kernel.test/pay';
  process.env.NEXT_PUBLIC_BASE_URL = 'https://market.test';
  process.env.NODE_DID = 'did:imajin:node';

  const limitMock = vi.fn();
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  return {
    limitMock,
    selectMock,
    getSessionMock: vi.fn(),
    requireHardDIDMock: vi.fn(),
    publishMock: vi.fn().mockResolvedValue(undefined),
    getAppServiceTokenMock: vi.fn(),
    recordPendingCheckoutMock: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('@/db', async () => ({
  db: { select: mocks.selectMock },
  listings: (await import('../../../../../../src/db/schema')).listings,
}));
vi.mock('@imajin/auth', () => ({
  getSession: mocks.getSessionMock,
  requireHardDID: mocks.requireHardDIDMock,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@imajin/bus', () => ({ publish: mocks.publishMock }));
vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/lib/utils', () => ({
  jsonResponse: (data: unknown, status = 200) => Response.json(data, { status }),
  errorResponse: (error: string, status = 400) => Response.json({ error }, { status }),
}));
vi.mock('@/lib/app-token', () => ({ getAppServiceToken: mocks.getAppServiceTokenMock }));
vi.mock('@/lib/pending-checkout', () => ({ recordPendingCheckout: mocks.recordPendingCheckoutMock }));
// buildPayeeChain is intentionally the real implementation (its own deps are mocked above).
vi.mock('@/lib/settle', async () => import('../../../../../../src/lib/settle'));

import { POST } from '../route';

const SELLER = 'did:imajin:seller';
const BUYER = 'did:imajin:buyer';
const NODE = 'did:imajin:node';
const LISTING_ID = 'lst_1';
const CHECKOUT_URL = 'https://pay.test/checkout/cs_test_1';
const PAY_CHECKOUT = 'https://kernel.test/pay/api/checkout';

const CHAIN_MANIFEST = {
  version: '1.0',
  fees: [{ role: 'processor', name: 'Stripe', rateBps: 290, fixedCents: 30 }],
  chain: [
    { did: SELLER, role: 'seller', share: 0.97 },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.01 },
    { did: 'did:imajin:protocol', role: 'protocol', share: 0.01 },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.01 },
  ],
};

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    sellerDid: SELLER,
    title: 'Vintage Chair',
    description: 'A chair',
    price: 2500,
    currency: 'CAD',
    status: 'active',
    sellerTier: 'public_onplatform',
    fairManifest: CHAIN_MANIFEST,
    ...overrides,
  };
}

const fetchMock = vi.fn();

function checkoutOk(overrides: Record<string, unknown> = {}) {
  return Response.json({ id: 'cs_test_1', url: CHECKOUT_URL, expiresAt: '2026-10-09T00:00:00.000Z', transactionId: 'tx_abc', ...overrides });
}

function purchase(body?: unknown) {
  return POST(
    new Request(`https://market.test/api/listings/${LISTING_ID}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
    { params: Promise.resolve({ id: LISTING_ID }) },
  );
}

const checkoutRequest = () => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
};

describe('POST /api/listings/:id/purchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    mocks.limitMock.mockResolvedValue([listingRow()]);
    mocks.getSessionMock.mockResolvedValue({ id: BUYER });
    mocks.requireHardDIDMock.mockResolvedValue({ identity: { id: BUYER } });
    mocks.getAppServiceTokenMock.mockReset().mockResolvedValue('app-token-1');
    mocks.recordPendingCheckoutMock.mockReset().mockResolvedValue(undefined);
    mocks.publishMock.mockResolvedValue(undefined);
    fetchMock.mockReset().mockImplementation(async () => checkoutOk());
  });

  describe('listing with a .fair chain', () => {
    it("checks out with market's own app-service token and declares the payee manifest", async () => {
      const res = await purchase();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url: CHECKOUT_URL, sessionId: 'cs_test_1' });

      const { url, headers, body } = checkoutRequest();
      expect(url).toBe(PAY_CHECKOUT);
      expect(headers.Authorization).toBe('Bearer app-token-1');
      // The listing manifest still drives pay's fee calculation; the payee manifest is what settle is verified against.
      expect(body.fairManifest).toEqual(CHAIN_MANIFEST);
      const payee = body.payeeManifest.chain as Array<{ did: string; role: string; amount: number }>;
      expect(payee.map((e) => [e.did, e.role])).toEqual([
        [SELLER, 'seller'],
        [NODE, 'node'],
        ['did:imajin:protocol', 'protocol'],
        [BUYER, 'buyer_credit'],
      ]);
      // Σchain == the gross payment the kernel records ($25.00): nothing is skimmed off for processing.
      expect(payee.reduce((sum, e) => sum + e.amount, 0)).toBeCloseTo(25, 2);
      expect(body.metadata).toMatchObject({ service: 'market', listingId: LISTING_ID, sellerDid: SELLER, buyerDid: BUYER });
    });

    it('remembers the kernel payment so the webhook can settle it', async () => {
      await purchase();

      const { body } = checkoutRequest();
      expect(mocks.recordPendingCheckoutMock).toHaveBeenCalledTimes(1);
      expect(mocks.recordPendingCheckoutMock).toHaveBeenCalledWith(LISTING_ID, 'cs_test_1', {
        transactionId: 'tx_abc',
        amountCents: 2500,
        chain: body.payeeManifest.chain,
      });
    });

    it('scales the declared amount by the requested quantity', async () => {
      await purchase({ quantity: 3 });

      const { body } = checkoutRequest();
      expect(body.items[0]).toMatchObject({ amount: 2500, quantity: 3 });
      const total = (body.payeeManifest.chain as Array<{ amount: number }>).reduce((sum, e) => sum + e.amount, 0);
      expect(total).toBeCloseTo(75, 2);
      expect(mocks.recordPendingCheckoutMock).toHaveBeenCalledWith(LISTING_ID, 'cs_test_1', expect.objectContaining({ amountCents: 7500 }));
    });

    it('declares an anonymous buyer as the kernel will record them', async () => {
      mocks.getSessionMock.mockResolvedValue(null);
      await purchase();

      const { body } = checkoutRequest();
      expect((body.payeeManifest.chain as Array<{ did: string; role: string }>).find((e) => e.role === 'buyer_credit')!.did).toBe('anonymous');
      expect(body.metadata).not.toHaveProperty('buyerDid');
    });

    it('uses the verified identity for a trust-gated listing', async () => {
      mocks.limitMock.mockResolvedValue([listingRow({ sellerTier: 'trust_gated' })]);
      await purchase();

      expect(mocks.requireHardDIDMock).toHaveBeenCalledTimes(1);
      expect(checkoutRequest().body.metadata.buyerDid).toBe(BUYER);
    });

    it('fails closed with 503 when the app token cannot be minted — no checkout, no money taken', async () => {
      mocks.getAppServiceTokenMock.mockRejectedValue(new Error('loadAppSigningKey: no keystore found'));

      const res = await purchase();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Payment service unavailable' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.log.error).toHaveBeenCalledWith({ err: expect.stringContaining('no keystore') }, expect.stringContaining('app-service token unavailable'));
    });

    it('still returns the checkout URL when pay returns no transactionId, and says so', async () => {
      fetchMock.mockImplementation(async () => checkoutOk({ transactionId: undefined }));

      const res = await purchase();

      expect(res.status).toBe(200);
      expect(mocks.recordPendingCheckoutMock).not.toHaveBeenCalled();
      expect(mocks.log.error).toHaveBeenCalledWith({ listingId: LISTING_ID }, expect.stringContaining('will not settle'));
    });

    it('still returns the checkout URL when pay returns no session id', async () => {
      fetchMock.mockImplementation(async () => checkoutOk({ id: undefined }));

      const res = await purchase();

      expect(res.status).toBe(200);
      expect(mocks.recordPendingCheckoutMock).not.toHaveBeenCalled();
    });

    it('still returns the checkout URL when recording the checkout fails, and says so', async () => {
      mocks.recordPendingCheckoutMock.mockRejectedValue(new Error('db down'));

      const res = await purchase();

      expect(res.status).toBe(200);
      expect(mocks.log.error).toHaveBeenCalledWith(
        { err: expect.stringContaining('db down'), listingId: LISTING_ID },
        expect.stringContaining('will not settle'),
      );
    });

    it('never sends a shared pay key', async () => {
      process.env.PAY_SERVICE_API_KEY = 'legacy-shared-key';
      try {
        await purchase();
        expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('legacy-shared-key');
      } finally {
        delete process.env.PAY_SERVICE_API_KEY;
      }
    });
  });

  describe('listing without a .fair chain', () => {
    it('checks out plainly: no token, no payee manifest, nothing recorded', async () => {
      mocks.limitMock.mockResolvedValue([listingRow({ fairManifest: null })]);

      const res = await purchase();

      expect(res.status).toBe(200);
      expect(mocks.getAppServiceTokenMock).not.toHaveBeenCalled();
      const { headers, body } = checkoutRequest();
      expect(headers).not.toHaveProperty('Authorization');
      expect(body).not.toHaveProperty('payeeManifest');
      // Falls back to the default platform manifest, as before.
      expect(body.fairManifest.type).toBe('market:purchase');
      expect(mocks.recordPendingCheckoutMock).not.toHaveBeenCalled();
    });
  });

  describe('request validation and failures', () => {
    it('404s an unknown listing', async () => {
      mocks.limitMock.mockResolvedValue([]);
      expect((await purchase()).status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a listing that is not active', async () => {
      mocks.limitMock.mockResolvedValue([listingRow({ status: 'sold' })]);
      expect((await purchase()).status).toBe(400);
    });

    it('rejects a listing that requires direct contact with the seller', async () => {
      mocks.limitMock.mockResolvedValue([listingRow({ sellerTier: 'public_offplatform' })]);
      expect((await purchase()).status).toBe(400);
    });

    it('requires a verified identity for a trust-gated listing', async () => {
      mocks.limitMock.mockResolvedValue([listingRow({ sellerTier: 'trust_gated' })]);
      mocks.requireHardDIDMock.mockResolvedValue({ error: 'nope' });

      expect((await purchase()).status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ignores a non-numeric or non-positive quantity', async () => {
      await purchase({ quantity: 'lots' });
      expect(checkoutRequest().body.items[0].quantity).toBe(1);

      fetchMock.mockClear();
      await purchase({ quantity: -2 });
      expect(checkoutRequest().body.items[0].quantity).toBe(1);
    });

    it('returns pay\'s error message when checkout is refused', async () => {
      fetchMock.mockImplementation(async () => Response.json({ error: 'Forbidden - scope \'pay:settle\' was not granted' }, { status: 403 }));

      const res = await purchase();

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Forbidden - scope 'pay:settle' was not granted" });
      expect(mocks.recordPendingCheckoutMock).not.toHaveBeenCalled();
    });

    it('falls back to a generic message when pay gives none', async () => {
      fetchMock.mockImplementation(async () => Response.json({}, { status: 502 }));
      expect(await (await purchase()).json()).toEqual({ error: 'Payment service error' });
    });

    it('returns 500 when the purchase blows up unexpectedly', async () => {
      mocks.limitMock.mockRejectedValue(new Error('db down'));
      const res = await purchase();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Purchase failed' });
    });

    it('publishes listing.purchase and survives a bus failure', async () => {
      mocks.publishMock.mockRejectedValue(new Error('bus down'));
      const res = await purchase();

      expect(res.status).toBe(200);
      expect(mocks.publishMock).toHaveBeenCalledWith('listing.purchase', expect.objectContaining({ scope: 'market', subject: BUYER }));
    });
  });
});
