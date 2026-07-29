import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
  settlements: { id: 'id', assetId: 'asset_id', action: 'action', receiptToken: 'receipt_token' },
  accessLog: { settlementId: 'settlement_id', at: 'at' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn((identity: { id: string }) => identity.id),
}));

const {
  mockBuild402Response,
  mockVerifyReceipt,
  mockLoadVerifyKey,
  mockIsFairManifestV1_1,
} = vi.hoisted(() => ({
  mockBuild402Response: vi.fn(),
  mockVerifyReceipt: vi.fn(),
  mockLoadVerifyKey: vi.fn(),
  mockIsFairManifestV1_1: vi.fn(),
}));

vi.mock('@imajin/fair', () => ({
  isFairManifestV1_1: mockIsFairManifestV1_1,
  build402Response: mockBuild402Response,
  verifyReceipt: mockVerifyReceipt,
  loadVerifyKey: mockLoadVerifyKey,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/src/lib/http/route-response', () => ({
  respondPaymentRequired: vi.fn((_req: unknown, body: unknown) => {
    const { NextResponse } = require('next/server');
    return NextResponse.json(body, { status: 402 });
  }),
}));

import { db } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { handleSettlement, determineAction } from '../settle';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string> = {}, url = 'https://test.imajin.ai/media/api/assets/asset_1'): NextRequest {
  return new Request(url, { headers }) as unknown as NextRequest;
}

const ASSET_ID = 'asset_1';

/** Minimal priced manifest */
function pricedManifest(action = 'reproduction') {
  return {
    fair: '1.1',
    distribution: {
      [action]: { mode: 'allowed', price: { amount: 100, currency: 'MJNX' } },
    },
  };
}

function setupDbSelect(rows: unknown[]) {
  const mockLimit = vi.fn().mockResolvedValue(rows);
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);
  return { mockFrom, mockWhere, mockLimit };
}

function setupDbInsert() {
  const mockValues = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValue({ values: mockValues } as never);
}

/**
 * Mock db.select for the two-query pattern in handleSettlement:
 * 1. Settlement lookup: `.from(settlements).where(...).limit(1)` → array with limit
 * 2. Replay count:     `.from(accessLog).where(...)` → awaited directly (no .limit)
 */
function setupDbForSettlementAndReplay(settlement: unknown, replayCount: number) {
  let callIndex = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const idx = callIndex++;
    if (idx === 0) {
      // Settlement lookup
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([settlement]),
          }),
        }),
      } as never;
    }
    // Replay count (awaited directly from .where())
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: replayCount }]),
      }),
    } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFairManifestV1_1.mockReturnValue(true);
  process.env.AUTH_PRIVATE_KEY = undefined;
});

// ---------------------------------------------------------------------------
// determineAction
// ---------------------------------------------------------------------------

describe('determineAction', () => {
  it('returns explicit action from query param', () => {
    const req = makeRequest({}, 'https://test.imajin.ai/api?action=syndication');
    expect(determineAction(req, 'image/png')).toBe('syndication');
  });

  it('returns streaming when Range header present on audio/video', () => {
    const req = makeRequest({ range: 'bytes=0-1023' }, 'https://test.imajin.ai/api');
    expect(determineAction(req, 'video/mp4')).toBe('streaming');
  });

  it('returns reproduction for Range header on non-audio/video', () => {
    const req = makeRequest({ range: 'bytes=0-1023' }, 'https://test.imajin.ai/api');
    expect(determineAction(req, 'image/png')).toBe('reproduction');
  });

  it('defaults to reproduction', () => {
    const req = makeRequest({}, 'https://test.imajin.ai/api');
    expect(determineAction(req, 'image/png')).toBe('reproduction');
  });
});

// ---------------------------------------------------------------------------
// handleSettlement — fast path (no price)
// ---------------------------------------------------------------------------

describe('handleSettlement — no price', () => {
  it('returns null when manifest is null', async () => {
    const result = await handleSettlement(makeRequest(), ASSET_ID, null, 'reproduction');
    expect(result).toBeNull();
  });

  it('returns null when isFairManifestV1_1 returns false', async () => {
    mockIsFairManifestV1_1.mockReturnValue(false);
    const result = await handleSettlement(makeRequest(), ASSET_ID, {} as never, 'reproduction');
    expect(result).toBeNull();
  });

  it('returns null when distribution right has no price', async () => {
    const manifest = { fair: '1.1', distribution: { reproduction: { mode: 'allowed' } } };
    const result = await handleSettlement(makeRequest(), ASSET_ID, manifest as never, 'reproduction');
    expect(result).toBeNull();
  });

  it('returns null when distribution right price amount is 0', async () => {
    const manifest = { fair: '1.1', distribution: { reproduction: { mode: 'allowed', price: { amount: 0 } } } };
    const result = await handleSettlement(makeRequest(), ASSET_ID, manifest as never, 'reproduction');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleSettlement — no receipt → 402
// ---------------------------------------------------------------------------

describe('handleSettlement — no receipt', () => {
  it('returns 402 when no X-Payment-Receipt header is present', async () => {
    mockBuild402Response.mockReturnValue({ body: { schemes: ['mjnx-direct'] }, headers: {} });

    const result = await handleSettlement(makeRequest(), ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result).not.toBeNull();
    expect(result?.status).toBe(402);
  });

  it('returns 500 when build402Response throws', async () => {
    mockBuild402Response.mockImplementation(() => { throw new Error('config error'); });

    const result = await handleSettlement(makeRequest(), ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result?.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// handleSettlement — receipt verification failures
// ---------------------------------------------------------------------------

describe('handleSettlement — receipt verification', () => {
  const requestWithReceipt = makeRequest({ 'x-payment-receipt': 'tok_receipt' });

  it('returns 402 when verifyReceipt throws', async () => {
    mockLoadVerifyKey.mockResolvedValue({} as never);
    mockVerifyReceipt.mockRejectedValue(new Error('bad sig'));

    const result = await handleSettlement(requestWithReceipt, ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result?.status).toBe(402);
    const body = await result?.json();
    expect(body.error).toContain('Invalid payment receipt');
  });

  it('returns 402 when receipt aud does not match asset id', async () => {
    mockLoadVerifyKey.mockResolvedValue({} as never);
    mockVerifyReceipt.mockResolvedValue({ aud: 'asset:other', action: 'reproduction', sub: 'settlement_1', buyer: 'did:imajin:buyer' });

    const result = await handleSettlement(requestWithReceipt, ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result?.status).toBe(402);
    const body = await result?.json();
    expect(body.error).toContain('audience mismatch');
  });

  it('returns 402 when receipt action does not match request action', async () => {
    mockLoadVerifyKey.mockResolvedValue({} as never);
    mockVerifyReceipt.mockResolvedValue({ aud: `asset:${ASSET_ID}`, action: 'streaming', sub: 'settlement_1', buyer: 'did:imajin:buyer' });

    const result = await handleSettlement(requestWithReceipt, ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result?.status).toBe(402);
    const body = await result?.json();
    expect(body.error).toContain('action mismatch');
  });
});

// ---------------------------------------------------------------------------
// handleSettlement — buyer auth + DB checks
// ---------------------------------------------------------------------------

describe('handleSettlement — buyer auth and DB', () => {
  const RECEIPT = 'tok_receipt';
  const BUYER_DID = 'did:imajin:buyer';

  function setupValidReceipt() {
    mockLoadVerifyKey.mockResolvedValue({} as never);
    mockVerifyReceipt.mockResolvedValue({
      aud: `asset:${ASSET_ID}`,
      action: 'reproduction',
      sub: 'settlement_1',
      buyer: BUYER_DID,
    });
  }

  it('returns 401 when buyer is not authenticated', async () => {
    setupValidReceipt();
    vi.mocked(requireAuth).mockResolvedValue({ error: 'Not authenticated', status: 401 } as never);

    const req = makeRequest({ 'x-payment-receipt': RECEIPT });
    const result = await handleSettlement(req, ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result?.status).toBe(401);
  });

  it('returns 403 when caller DID does not match receipt buyer', async () => {
    setupValidReceipt();
    vi.mocked(requireAuth).mockResolvedValue({ identity: { id: 'did:imajin:intruder' } } as never);

    const req = makeRequest({ 'x-payment-receipt': RECEIPT });
    const result = await handleSettlement(req, ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result?.status).toBe(403);
  });

  it('returns 402 when settlement record is not found in DB', async () => {
    setupValidReceipt();
    vi.mocked(requireAuth).mockResolvedValue({ identity: { id: BUYER_DID } } as never);
    setupDbSelect([]);  // no settlement found

    const req = makeRequest({ 'x-payment-receipt': RECEIPT });
    const result = await handleSettlement(req, ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result?.status).toBe(402);
    const body = await result?.json();
    expect(body.error).toContain('Settlement not found');
  });

  it('returns 429 when replay count exceeds 100', async () => {
    setupValidReceipt();
    vi.mocked(requireAuth).mockResolvedValue({ identity: { id: BUYER_DID } } as never);
    setupDbForSettlementAndReplay({ id: 'settlement_1', buyerDid: BUYER_DID }, 101);

    const req = makeRequest({ 'x-payment-receipt': RECEIPT });
    const result = await handleSettlement(req, ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result?.status).toBe(429);
  });

  it('returns null (proceeds) when all checks pass', async () => {
    setupValidReceipt();
    vi.mocked(requireAuth).mockResolvedValue({ identity: { id: BUYER_DID } } as never);
    setupDbInsert();
    setupDbForSettlementAndReplay({ id: 'settlement_1', buyerDid: BUYER_DID }, 0);

    const req = makeRequest({ 'x-payment-receipt': RECEIPT });
    const result = await handleSettlement(req, ASSET_ID, pricedManifest() as never, 'reproduction');
    expect(result).toBeNull();
  });
});
