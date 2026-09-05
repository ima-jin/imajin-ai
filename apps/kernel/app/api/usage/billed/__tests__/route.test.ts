import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  insertManualBilledLine: vi.fn(),
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

vi.mock('@/src/lib/usage/billed/manual', () => ({
  insertManualBilledLine: mocks.insertManualBilledLine,
}));

import { POST, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('https://kernel.test/api/usage/billed', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function goodBody(overrides: Record<string, unknown> = {}) {
  return {
    vendor: 'Warp',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-06-30T23:59:59.000Z',
    amountMinor: 12345,
    currency: 'USD',
    source: 'manual',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  mocks.insertManualBilledLine.mockResolvedValue({
    id: 'billed_1',
    principalDid: OWNER_DID,
    vendor: 'Warp',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-06-30T23:59:59.000Z',
    amountMinor: 12345,
    currency: 'USD',
    category: null,
    description: null,
    source: 'manual',
    evidenceAssetId: null,
    evidenceContentHash: null,
    attestationId: 'att_1',
  });
});

describe('POST /api/usage/billed — auth', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq(goodBody()));

    expect(res.status).toBe(401);
    expect(mocks.insertManualBilledLine).not.toHaveBeenCalled();
  });

  it('writes onBehalfOf the resolved effective DID (actingFor), never the raw caller id', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:agent', actingFor: OWNER_DID } });

    await POST(makeReq(goodBody()));

    expect(mocks.insertManualBilledLine).toHaveBeenCalledWith(expect.objectContaining({ principalDid: OWNER_DID }));
  });
});

describe('POST /api/usage/billed — body validation', () => {
  it('rejects invalid JSON', async () => {
    const req = new NextRequest('https://kernel.test/api/usage/billed', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects a missing vendor', async () => {
    const res = await POST(makeReq(goodBody({ vendor: undefined })));
    expect(res.status).toBe(400);
  });

  it('rejects a missing currency', async () => {
    const res = await POST(makeReq(goodBody({ currency: '' })));
    expect(res.status).toBe(400);
  });

  it('rejects a non-integer amountMinor', async () => {
    const res = await POST(makeReq(goodBody({ amountMinor: 12.5 })));
    expect(res.status).toBe(400);
  });

  it("rejects a source other than 'manual' or 'document'", async () => {
    const res = await POST(makeReq(goodBody({ source: 'api' })));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid periodStart/periodEnd', async () => {
    const res = await POST(makeReq(goodBody({ periodStart: 'not-a-date' })));
    expect(res.status).toBe(400);
  });

  it('rejects periodEnd before periodStart', async () => {
    const res = await POST(makeReq(goodBody({ periodStart: '2026-06-30T00:00:00.000Z', periodEnd: '2026-06-01T00:00:00.000Z' })));
    expect(res.status).toBe(400);
  });

  it('accepts a past period (backfill)', async () => {
    const res = await POST(makeReq(goodBody({ periodStart: '2020-01-01T00:00:00.000Z', periodEnd: '2020-01-31T00:00:00.000Z' })));
    expect(res.status).toBe(201);
  });

  it('accepts optional category/description/evidenceAssetId when present', async () => {
    const res = await POST(makeReq(goodBody({ category: 'infra', description: 'note', evidenceAssetId: 'asset_1' })));

    expect(res.status).toBe(201);
    expect(mocks.insertManualBilledLine).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'infra', description: 'note', evidenceAssetId: 'asset_1' }),
    );
  });
});

describe('POST /api/usage/billed — write outcomes', () => {
  it('never writes to usage.incurred (route only ever calls the manual billed writer)', async () => {
    await POST(makeReq(goodBody()));
    expect(mocks.insertManualBilledLine).toHaveBeenCalledOnce();
  });

  it('returns 201 with the created line item on success', async () => {
    const res = await POST(makeReq(goodBody()));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'billed_1', attestationId: 'att_1' });
  });

  it('returns 404 when the evidence asset does not exist', async () => {
    mocks.insertManualBilledLine.mockResolvedValueOnce({ error: 'evidence_asset_not_found' });

    const res = await POST(makeReq(goodBody({ evidenceAssetId: 'asset_missing' })));

    expect(res.status).toBe(404);
  });

  it('returns 403 when the evidence asset is not owned by the principal', async () => {
    mocks.insertManualBilledLine.mockResolvedValueOnce({ error: 'evidence_asset_not_owned' });

    const res = await POST(makeReq(goodBody({ evidenceAssetId: 'asset_1' })));

    expect(res.status).toBe(403);
  });

  it('returns 409 on a duplicate (vendor, period) unique-violation', async () => {
    mocks.insertManualBilledLine.mockRejectedValueOnce({ code: '23505' });

    const res = await POST(makeReq(goodBody()));

    expect(res.status).toBe(409);
  });

  it('returns 500 without leaking the underlying failure for any other error', async () => {
    mocks.insertManualBilledLine.mockRejectedValueOnce(new Error('db down'));

    const res = await POST(makeReq(goodBody()));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to record usage.billed line item' });
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq({}));
    expect(res.status).toBe(204);
  });
});
