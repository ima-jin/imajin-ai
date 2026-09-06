import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  confirmReceiptLines: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth,
  resolveActingDid: (identity: { actingFor?: string; id: string }) => identity.actingFor ?? identity.id,
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://example.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/usage/billed/receipt', () => ({
  confirmReceiptLines: mocks.confirmReceiptLines,
}));

import { POST, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('https://kernel.test/usage/api/receipts', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function goodBody(overrides: Record<string, unknown> = {}) {
  return {
    assetId: 'asset_1',
    currency: 'USD',
    receiptTotalMinor: 3000,
    lines: [
      { description: 'Laptop stand', category: 'hardware', amountMinor: 3000, date: '2026-06-01T00:00:00.000Z', vendor: 'Acme' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  mocks.confirmReceiptLines.mockResolvedValue({
    receiptId: 'receipt_1',
    assetId: 'asset_1',
    evidenceContentHash: 'sha256:abc',
    currency: 'USD',
    receiptTotalMinor: 3000,
    lines: [{ id: 'billed_1', lineNo: 1, description: 'Laptop stand', category: 'hardware', vendor: 'Acme', amountMinor: 3000, currency: 'USD', date: '2026-06-01T00:00:00.000Z', billedUsd: '30.00' }],
    attestationId: 'att_1',
  });
});

describe('POST /usage/api/receipts — auth', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq(goodBody()));

    expect(res.status).toBe(401);
    expect(mocks.confirmReceiptLines).not.toHaveBeenCalled();
  });

  it('writes onBehalfOf the resolved effective DID (actingFor), never the raw caller id', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:agent', actingFor: OWNER_DID } });

    await POST(makeReq(goodBody()));

    expect(mocks.confirmReceiptLines).toHaveBeenCalledWith(expect.objectContaining({ principalDid: OWNER_DID }));
  });
});

describe('POST /usage/api/receipts — body validation', () => {
  it('rejects invalid JSON', async () => {
    const req = new NextRequest('https://kernel.test/usage/api/receipts', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects a missing assetId', async () => {
    const res = await POST(makeReq(goodBody({ assetId: undefined })));
    expect(res.status).toBe(400);
  });

  it.each([
    ['', 'missing'],
    ['usd', 'lowercase'],
    ['DOLLARS', 'not 3 letters'],
  ])('rejects a malformed currency code %j (%s)', async (currency) => {
    const res = await POST(makeReq(goodBody({ currency })));
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed non-USD currency (FX handled downstream)', async () => {
    const res = await POST(makeReq(goodBody({ currency: 'CAD', lines: [{ description: 'Server rack', amountMinor: 3000, date: '2026-06-01T00:00:00.000Z', vendor: 'Acme' }] })));
    expect(res.status).toBe(201);
  });

  it('rejects a non-integer receiptTotalMinor', async () => {
    const res = await POST(makeReq(goodBody({ receiptTotalMinor: 30.5 })));
    expect(res.status).toBe(400);
  });

  it('rejects an empty lines array', async () => {
    const res = await POST(makeReq(goodBody({ lines: [] })));
    expect(res.status).toBe(400);
    expect(mocks.confirmReceiptLines).not.toHaveBeenCalled();
  });

  it('rejects a line missing vendor', async () => {
    const res = await POST(makeReq(goodBody({ lines: [{ description: 'x', amountMinor: 100, date: '2026-06-01T00:00:00.000Z' }] })));
    expect(res.status).toBe(400);
  });

  it('rejects a line with a currency that does not match the receipt currency', async () => {
    const res = await POST(makeReq(goodBody({ lines: [{ description: 'x', amountMinor: 3000, date: '2026-06-01T00:00:00.000Z', vendor: 'Acme', currency: 'CAD' }] })));
    expect(res.status).toBe(400);
  });

  it('rejects a negative amountMinor on a line', async () => {
    const res = await POST(makeReq(goodBody({ lines: [{ description: 'x', amountMinor: -1, date: '2026-06-01T00:00:00.000Z', vendor: 'Acme' }] })));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid line date', async () => {
    const res = await POST(makeReq(goodBody({ lines: [{ description: 'x', amountMinor: 3000, date: 'not-a-date', vendor: 'Acme' }] })));
    expect(res.status).toBe(400);
  });
});

describe('POST /usage/api/receipts — write outcomes', () => {
  it('returns 201 with the confirmed receipt on success', async () => {
    const res = await POST(makeReq(goodBody()));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ receiptId: 'receipt_1', attestationId: 'att_1' });
  });

  it('returns 404 when the asset does not exist', async () => {
    mocks.confirmReceiptLines.mockResolvedValueOnce({ error: 'evidence_asset_not_found' });
    const res = await POST(makeReq(goodBody()));
    expect(res.status).toBe(404);
  });

  it('returns 403 when the asset is not owned by the principal', async () => {
    mocks.confirmReceiptLines.mockResolvedValueOnce({ error: 'evidence_asset_not_owned' });
    const res = await POST(makeReq(goodBody()));
    expect(res.status).toBe(403);
  });

  it('returns 422 with expected/actual minors on a sum mismatch', async () => {
    mocks.confirmReceiptLines.mockResolvedValueOnce({ error: 'sum_mismatch', expectedMinor: 3000, actualMinor: 100 });

    const res = await POST(makeReq(goodBody()));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'sum_mismatch', expectedMinor: 3000, actualMinor: 100 });
  });

  it('returns 502 when FX resolution fails', async () => {
    mocks.confirmReceiptLines.mockResolvedValueOnce({ error: 'fx_unavailable', cause: 'ECB down' });
    const res = await POST(makeReq(goodBody()));
    expect(res.status).toBe(502);
  });

  it('returns 500 without leaking the underlying failure for an unexpected throw', async () => {
    mocks.confirmReceiptLines.mockRejectedValueOnce(new Error('db down'));

    const res = await POST(makeReq(goodBody()));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to record receipt line items' });
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq({}));
    expect(res.status).toBe(204);
  });
});
