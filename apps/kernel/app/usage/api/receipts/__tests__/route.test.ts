/**
 * Route tests for both `/usage/api/receipts*` endpoints (#1951). Kept in
 * one file — rather than mirroring each route file with its own colocated
 * test file — because the confirm and extract routes share the exact same
 * auth/logger/CORS mock surface; splitting them would duplicate that
 * boilerplate rather than reuse it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  confirmReceiptLines: vi.fn(),
  extractReceiptDraft: vi.fn(),
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

vi.mock('@/src/lib/usage/billed/receipt-extract', () => ({
  extractReceiptDraft: mocks.extractReceiptDraft,
}));

import { POST as confirmPost, OPTIONS as confirmOptions } from '../route';
import { POST as extractPost, OPTIONS as extractOptions } from '../extract/route';

const OWNER_DID = 'did:imajin:owner';

function makeReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function makeConfirmReq(body: unknown): NextRequest {
  return makeReq('https://kernel.test/usage/api/receipts', body);
}

function makeExtractReq(body: unknown): NextRequest {
  return makeReq('https://kernel.test/usage/api/receipts/extract', body);
}

function goodConfirmBody(overrides: Record<string, unknown> = {}) {
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
  mocks.extractReceiptDraft.mockResolvedValue({
    status: 'unconfirmed',
    assetId: 'asset_1',
    connector: 'local',
    modelId: 'qwen2.5vl:7b',
    lines: [{ description: 'Widget', category: null, amount: '19.99', currency: 'USD', date: null, vendor: null }],
  });
});

describe('POST /usage/api/receipts — auth', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await confirmPost(makeConfirmReq(goodConfirmBody()));

    expect(res.status).toBe(401);
    expect(mocks.confirmReceiptLines).not.toHaveBeenCalled();
  });

  it('writes onBehalfOf the resolved effective DID (actingFor), never the raw caller id', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:agent', actingFor: OWNER_DID } });

    await confirmPost(makeConfirmReq(goodConfirmBody()));

    expect(mocks.confirmReceiptLines).toHaveBeenCalledWith(expect.objectContaining({ principalDid: OWNER_DID }));
  });
});

describe('POST /usage/api/receipts — body validation', () => {
  it('rejects invalid JSON', async () => {
    const req = new NextRequest('https://kernel.test/usage/api/receipts', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    const res = await confirmPost(req);
    expect(res.status).toBe(400);
  });

  it('rejects a missing assetId', async () => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody({ assetId: undefined })));
    expect(res.status).toBe(400);
  });

  it.each([
    ['', 'missing'],
    ['usd', 'lowercase'],
    ['DOLLARS', 'not 3 letters'],
  ])('rejects a malformed currency code %j (%s)', async (currency) => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody({ currency })));
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed non-USD currency (FX handled downstream)', async () => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody({ currency: 'CAD', lines: [{ description: 'Server rack', amountMinor: 3000, date: '2026-06-01T00:00:00.000Z', vendor: 'Acme' }] })));
    expect(res.status).toBe(201);
  });

  it('rejects a non-integer receiptTotalMinor', async () => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody({ receiptTotalMinor: 30.5 })));
    expect(res.status).toBe(400);
  });

  it('rejects an empty lines array', async () => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody({ lines: [] })));
    expect(res.status).toBe(400);
    expect(mocks.confirmReceiptLines).not.toHaveBeenCalled();
  });

  it('rejects a line missing vendor', async () => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody({ lines: [{ description: 'x', amountMinor: 100, date: '2026-06-01T00:00:00.000Z' }] })));
    expect(res.status).toBe(400);
  });

  it('rejects a line with a currency that does not match the receipt currency', async () => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody({ lines: [{ description: 'x', amountMinor: 3000, date: '2026-06-01T00:00:00.000Z', vendor: 'Acme', currency: 'CAD' }] })));
    expect(res.status).toBe(400);
  });

  it('rejects a negative amountMinor on a line', async () => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody({ lines: [{ description: 'x', amountMinor: -1, date: '2026-06-01T00:00:00.000Z', vendor: 'Acme' }] })));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid line date', async () => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody({ lines: [{ description: 'x', amountMinor: 3000, date: 'not-a-date', vendor: 'Acme' }] })));
    expect(res.status).toBe(400);
  });
});

describe('POST /usage/api/receipts — write outcomes', () => {
  it('returns 201 with the confirmed receipt on success', async () => {
    const res = await confirmPost(makeConfirmReq(goodConfirmBody()));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ receiptId: 'receipt_1', attestationId: 'att_1' });
  });

  it('returns 404 when the asset does not exist', async () => {
    mocks.confirmReceiptLines.mockResolvedValueOnce({ error: 'evidence_asset_not_found' });
    const res = await confirmPost(makeConfirmReq(goodConfirmBody()));
    expect(res.status).toBe(404);
  });

  it('returns 403 when the asset is not owned by the principal', async () => {
    mocks.confirmReceiptLines.mockResolvedValueOnce({ error: 'evidence_asset_not_owned' });
    const res = await confirmPost(makeConfirmReq(goodConfirmBody()));
    expect(res.status).toBe(403);
  });

  it('returns 422 with expected/actual minors on a sum mismatch', async () => {
    mocks.confirmReceiptLines.mockResolvedValueOnce({ error: 'sum_mismatch', expectedMinor: 3000, actualMinor: 100 });

    const res = await confirmPost(makeConfirmReq(goodConfirmBody()));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'sum_mismatch', expectedMinor: 3000, actualMinor: 100 });
  });

  it('returns 502 when FX resolution fails', async () => {
    mocks.confirmReceiptLines.mockResolvedValueOnce({ error: 'fx_unavailable', cause: 'ECB down' });
    const res = await confirmPost(makeConfirmReq(goodConfirmBody()));
    expect(res.status).toBe(502);
  });

  it('returns 500 without leaking the underlying failure for an unexpected throw', async () => {
    mocks.confirmReceiptLines.mockRejectedValueOnce(new Error('db down'));

    const res = await confirmPost(makeConfirmReq(goodConfirmBody()));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to record receipt line items' });
  });

  it('answers CORS pre-flight', async () => {
    const res = await confirmOptions(makeConfirmReq({}));
    expect(res.status).toBe(204);
  });
});

describe('POST /usage/api/receipts/extract — auth', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await extractPost(makeExtractReq({ assetId: 'asset_1' }));

    expect(res.status).toBe(401);
    expect(mocks.extractReceiptDraft).not.toHaveBeenCalled();
  });

  it('extracts onBehalfOf the resolved effective DID (actingFor)', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:agent', actingFor: OWNER_DID } });

    await extractPost(makeExtractReq({ assetId: 'asset_1' }));

    expect(mocks.extractReceiptDraft).toHaveBeenCalledWith({ ownerDid: OWNER_DID, assetId: 'asset_1' });
  });
});

describe('POST /usage/api/receipts/extract — body validation', () => {
  it('rejects invalid JSON', async () => {
    const req = new NextRequest('https://kernel.test/usage/api/receipts/extract', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    const res = await extractPost(req);
    expect(res.status).toBe(400);
  });

  it('rejects a missing assetId', async () => {
    const res = await extractPost(makeExtractReq({}));
    expect(res.status).toBe(400);
    expect(mocks.extractReceiptDraft).not.toHaveBeenCalled();
  });
});

describe('POST /usage/api/receipts/extract — outcomes', () => {
  it('returns 200 with the unconfirmed draft on success (never 201 — nothing is persisted)', async () => {
    const res = await extractPost(makeExtractReq({ assetId: 'asset_1' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'unconfirmed' });
  });

  it('returns 404 when the asset does not exist', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'asset_not_found' });
    const res = await extractPost(makeExtractReq({ assetId: 'asset_missing' }));
    expect(res.status).toBe(404);
  });

  it('returns 403 when the asset is not owned by the caller', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'asset_not_owned' });
    const res = await extractPost(makeExtractReq({ assetId: 'asset_1' }));
    expect(res.status).toBe(403);
  });

  it('returns 415 for a non-image asset', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'unsupported_mime_type', mimeType: 'application/pdf' });
    const res = await extractPost(makeExtractReq({ assetId: 'asset_1' }));
    expect(res.status).toBe(415);
  });

  it('returns 409 when no local brain is sealed', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'no_local_brain', cause: 'nothing sealed' });
    const res = await extractPost(makeExtractReq({ assetId: 'asset_1' }));
    expect(res.status).toBe(409);
  });

  it('returns 502 on extraction failure', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'extraction_failed', cause: 'bad output' });
    const res = await extractPost(makeExtractReq({ assetId: 'asset_1' }));
    expect(res.status).toBe(502);
  });

  it('returns 500 without leaking the underlying failure for an unexpected throw', async () => {
    mocks.extractReceiptDraft.mockRejectedValueOnce(new Error('boom'));

    const res = await extractPost(makeExtractReq({ assetId: 'asset_1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to extract receipt draft' });
  });

  it('answers CORS pre-flight', async () => {
    const res = await extractOptions(makeExtractReq({}));
    expect(res.status).toBe(204);
  });
});
