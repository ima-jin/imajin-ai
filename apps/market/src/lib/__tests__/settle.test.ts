/**
 * Tests for apps/market/src/lib/settle.ts (#2740) — market settles via the
 * registered-app contract on pay's /api/settle: its own app-service token,
 * the checkout's transaction_id, and the payee chain declared at checkout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAppServiceToken: vi.fn(),
  saveSettlementSnapshot: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/app-token', () => ({ getAppServiceToken: mocks.getAppServiceToken }));
vi.mock('@/lib/pending-checkout', () => ({ saveSettlementSnapshot: mocks.saveSettlementSnapshot }));
vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));

import { buildPayeeChain, settleListingPurchase, type FairManifest } from '../settle';
import type { PendingCheckout } from '../pending-checkout';

const SELLER = 'did:imajin:seller';
const BUYER = 'did:imajin:buyer';
const NODE = 'did:imajin:node';
const PROTOCOL = 'did:imajin:protocol';
const PAY_URL = 'https://kernel.test/pay';
const LISTING_ID = 'lst_1';
const SESSION_ID = 'cs_test_1';

const MANIFEST: FairManifest = {
  version: '1.0',
  fees: [{ role: 'processor', name: 'Stripe', rateBps: 290, fixedCents: 30 }],
  chain: [
    { did: SELLER, role: 'seller', share: 0.97 },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.01 },
    { did: PROTOCOL, role: 'protocol', share: 0.01 },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.01 },
  ],
};

const PENDING: PendingCheckout = {
  transactionId: 'tx_abc',
  amountCents: 1999,
  chain: [
    { did: SELLER, role: 'seller', amount: 19.39 },
    { did: NODE, role: 'node', amount: 0.2 },
  ],
  at: '2026-10-08T12:00:00.000Z',
};

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const settleParams = (overrides: Partial<Parameters<typeof settleListingPurchase>[0]> = {}) => ({
  listingId: LISTING_ID,
  sessionId: SESSION_ID,
  pending: PENDING,
  currency: 'CAD',
  fairManifest: MANIFEST,
  ...overrides,
});

const sentRequest = () => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
};

describe('buildPayeeChain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_DID', NODE);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns null for a manifest without a chain (never settled)', () => {
    expect(buildPayeeChain({ amountCents: 1999, fairManifest: null })).toBeNull();
    expect(buildPayeeChain({ amountCents: 1999, fairManifest: { version: '1.0', distributions: [] } })).toBeNull();
    expect(buildPayeeChain({ amountCents: 1999, fairManifest: { chain: [] } })).toBeNull();
  });

  it('resolves placeholders and sums to the GROSS payment with no processor-fee deduction', () => {
    const chain = buildPayeeChain({ amountCents: 1999, fairManifest: MANIFEST, buyerDid: BUYER })!;

    expect(chain.map((e) => [e.did, e.role])).toEqual([
      [SELLER, 'seller'],
      [NODE, 'node'],
      [PROTOCOL, 'protocol'],
      [BUYER, 'buyer_credit'],
    ]);
    // The kernel requires Σchain == the recorded payment total (19.99), so the manifest's
    // 2.9% + 30¢ processor fee must NOT be taken out of the seller's share here.
    const sum = chain.reduce((total, entry) => total + entry.amount, 0);
    expect(sum).toBeCloseTo(19.99, 2);
    expect(chain[0]!.amount).toBeGreaterThan(19);
  });

  it('settles an anonymous buyer under the kernel\'s recorded payer, not an empty DID', () => {
    const chain = buildPayeeChain({ amountCents: 1000, fairManifest: MANIFEST })!;
    expect(chain.find((e) => e.role === 'buyer_credit')!.did).toBe('anonymous');
  });

  it('warns and uses the unresolved-node sentinel when NODE_DID is not configured', () => {
    vi.stubEnv('NODE_DID', '');
    vi.stubEnv('RELAY_IMAJIN_DID', '');
    const chain = buildPayeeChain({ amountCents: 1000, fairManifest: MANIFEST, buyerDid: BUYER })!;

    expect(mocks.log.warn).toHaveBeenCalledWith({}, expect.stringContaining('NODE_DID not set'));
    expect(chain.find((e) => e.role === 'node')!.did).toBe('did:imajin:node-unresolved');
  });

  it('falls back to RELAY_IMAJIN_DID for the node fee recipient', () => {
    vi.stubEnv('NODE_DID', '');
    vi.stubEnv('RELAY_IMAJIN_DID', 'did:imajin:relay');
    const chain = buildPayeeChain({ amountCents: 1000, fairManifest: MANIFEST, buyerDid: BUYER })!;
    expect(chain.find((e) => e.role === 'node')!.did).toBe('did:imajin:relay');
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });
});

describe('settleListingPurchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('PAY_SERVICE_URL', PAY_URL);
    mocks.getAppServiceToken.mockReset().mockResolvedValue('app-token-1');
    mocks.saveSettlementSnapshot.mockReset().mockResolvedValue(undefined);
    fetchMock.mockReset().mockImplementation(async () =>
      jsonResponse({ settled: true, batchId: 'batch_1', transactions: ['tx1'], total_amount: 19.99, recipients: 2 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("settles with market's own app token, the checkout's transaction_id and the declared chain", async () => {
    await settleListingPurchase(settleParams());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, headers, body } = sentRequest();
    expect(url).toBe(`${PAY_URL}/api/settle`);
    expect(init.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer app-token-1');
    expect(body).toEqual({
      transaction_id: 'tx_abc',
      fair_manifest: { chain: PENDING.chain },
      total_amount: 19.99,
      metadata: { listingId: LISTING_ID },
    });
    // The kernel owns payer / service / type / rail — none of it is sent.
    expect(body).not.toHaveProperty('from_did');
    expect(body).not.toHaveProperty('service');
    expect(body).not.toHaveProperty('funded');
    expect(mocks.log.info).toHaveBeenCalledWith({ listingId: LISTING_ID, batchId: 'batch_1' }, expect.stringContaining('Settlement complete'));
  });

  it('snapshots the .fair receipt and clears the pending entry after settling', async () => {
    await settleListingPurchase(settleParams());

    expect(mocks.saveSettlementSnapshot).toHaveBeenCalledTimes(1);
    const [listingId, sessionId, receipt] = mocks.saveSettlementSnapshot.mock.calls[0]!;
    expect(listingId).toBe(LISTING_ID);
    expect(sessionId).toBe(SESSION_ID);
    expect(receipt).toMatchObject({
      version: '1.0',
      totalAmount: 19.99,
      netAmount: 19.99,
      currency: 'CAD',
      chain: PENDING.chain,
      fees: [{ role: 'processor', name: 'Stripe', rateBps: 290, fixedCents: 30, amount: 0.88, estimated: true }],
    });
    expect(typeof receipt.settledAt).toBe('string');
  });

  it('uses the manifest\'s `fair` stamp, then 1.0, for the receipt version and tolerates no fees', async () => {
    await settleListingPurchase(settleParams({ fairManifest: { fair: '1.2', chain: MANIFEST.chain } }));
    expect(mocks.saveSettlementSnapshot.mock.calls[0]![2]).toMatchObject({ version: '1.2', fees: [] });

    mocks.saveSettlementSnapshot.mockClear();
    await settleListingPurchase(settleParams({ fairManifest: null }));
    expect(mocks.saveSettlementSnapshot.mock.calls[0]![2]).toMatchObject({ version: '1.0', fees: [] });
  });

  it('treats alreadySettled: true as success (idempotent replay)', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ settled: true, alreadySettled: true, batchId: 'batch_1', transactions: ['tx1'], total_amount: 19.99, recipients: 2 }),
    );

    await settleListingPurchase(settleParams());

    expect(mocks.log.error).not.toHaveBeenCalled();
    expect(mocks.log.info).toHaveBeenCalledWith({ listingId: LISTING_ID, batchId: 'batch_1' }, expect.stringContaining('already settled'));
    // Success path: the receipt is (re)written and the pending entry cleared.
    expect(mocks.saveSettlementSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not snapshot when pay refuses with 403 (pay:settle not granted / not approved)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: "Forbidden - scope 'pay:settle' was not granted" }, 403));

    await expect(settleListingPurchase(settleParams())).resolves.toBeUndefined();

    expect(mocks.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: LISTING_ID, status: 403, text: expect.stringContaining('pay:settle') }),
      expect.stringContaining('returned error'),
    );
    expect(mocks.saveSettlementSnapshot).not.toHaveBeenCalled();
  });

  it('does not snapshot when pay refuses with 401 (retired shared key / bad token)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'Unauthorized - invalid or expired app-service token' }, 401));

    await settleListingPurchase(settleParams());

    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }), expect.any(String));
    expect(mocks.saveSettlementSnapshot).not.toHaveBeenCalled();
  });

  it('is non-fatal when the app token cannot be minted, and never calls pay', async () => {
    mocks.getAppServiceToken.mockRejectedValue(new Error('app-token: service token mint failed (App is not active)'));

    await expect(settleListingPurchase(settleParams())).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalledWith({ err: expect.stringContaining('mint failed') }, expect.stringContaining('non-fatal'));
  });

  it('is non-fatal when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(settleListingPurchase(settleParams())).resolves.toBeUndefined();

    expect(mocks.log.error).toHaveBeenCalledWith({ err: expect.stringContaining('ECONNREFUSED') }, expect.stringContaining('non-fatal'));
    expect(mocks.saveSettlementSnapshot).not.toHaveBeenCalled();
  });

  it('keeps a completed settlement even if saving the receipt fails', async () => {
    mocks.saveSettlementSnapshot.mockRejectedValue(new Error('db down'));

    await expect(settleListingPurchase(settleParams())).resolves.toBeUndefined();

    expect(mocks.log.warn).toHaveBeenCalledWith({ err: expect.stringContaining('db down') }, expect.stringContaining('Failed to snapshot'));
    expect(mocks.log.error).not.toHaveBeenCalled();
  });
});
