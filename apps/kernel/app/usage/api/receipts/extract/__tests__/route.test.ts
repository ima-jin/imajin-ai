import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
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

vi.mock('@/src/lib/usage/billed/receipt-extract', () => ({
  extractReceiptDraft: mocks.extractReceiptDraft,
}));

import { POST, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('https://kernel.test/usage/api/receipts/extract', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  mocks.extractReceiptDraft.mockResolvedValue({
    status: 'unconfirmed',
    assetId: 'asset_1',
    connector: 'local',
    modelId: 'qwen2.5vl:7b',
    lines: [{ description: 'Widget', category: null, amount: '19.99', currency: 'USD', date: null, vendor: null }],
  });
});

describe('POST /usage/api/receipts/extract — auth', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq({ assetId: 'asset_1' }));

    expect(res.status).toBe(401);
    expect(mocks.extractReceiptDraft).not.toHaveBeenCalled();
  });

  it('extracts onBehalfOf the resolved effective DID (actingFor)', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:agent', actingFor: OWNER_DID } });

    await POST(makeReq({ assetId: 'asset_1' }));

    expect(mocks.extractReceiptDraft).toHaveBeenCalledWith({ ownerDid: OWNER_DID, assetId: 'asset_1' });
  });
});

describe('POST /usage/api/receipts/extract — body validation', () => {
  it('rejects invalid JSON', async () => {
    const req = new NextRequest('https://kernel.test/usage/api/receipts/extract', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects a missing assetId', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(mocks.extractReceiptDraft).not.toHaveBeenCalled();
  });
});

describe('POST /usage/api/receipts/extract — outcomes', () => {
  it('returns 200 with the unconfirmed draft on success (never 201 — nothing is persisted)', async () => {
    const res = await POST(makeReq({ assetId: 'asset_1' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'unconfirmed' });
  });

  it('returns 404 when the asset does not exist', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'asset_not_found' });
    const res = await POST(makeReq({ assetId: 'asset_missing' }));
    expect(res.status).toBe(404);
  });

  it('returns 403 when the asset is not owned by the caller', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'asset_not_owned' });
    const res = await POST(makeReq({ assetId: 'asset_1' }));
    expect(res.status).toBe(403);
  });

  it('returns 415 for a non-image asset', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'unsupported_mime_type', mimeType: 'application/pdf' });
    const res = await POST(makeReq({ assetId: 'asset_1' }));
    expect(res.status).toBe(415);
  });

  it('returns 409 when no local brain is sealed', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'no_local_brain', cause: 'nothing sealed' });
    const res = await POST(makeReq({ assetId: 'asset_1' }));
    expect(res.status).toBe(409);
  });

  it('returns 502 on extraction failure', async () => {
    mocks.extractReceiptDraft.mockResolvedValueOnce({ error: 'extraction_failed', cause: 'bad output' });
    const res = await POST(makeReq({ assetId: 'asset_1' }));
    expect(res.status).toBe(502);
  });

  it('returns 500 without leaking the underlying failure for an unexpected throw', async () => {
    mocks.extractReceiptDraft.mockRejectedValueOnce(new Error('boom'));

    const res = await POST(makeReq({ assetId: 'asset_1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to extract receipt draft' });
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq({}));
    expect(res.status).toBe(204);
  });
});
