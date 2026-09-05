import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  readUsageSummary: vi.fn(),
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

vi.mock('@/src/lib/usage/summary', () => ({ readUsageSummary: mocks.readUsageSummary }));

import { GET, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';
const AGENT_DID = 'did:imajin:agent';

function makeReq(url: string): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  mocks.readUsageSummary.mockResolvedValue({
    did: OWNER_DID,
    window: '2026-08',
    incurred: { total: 0, byProvider: {} },
    billed: { total: 0, byVendor: {}, bySource: {} },
    drift: 0,
    rollup: null,
    currency: 'USD',
  });
});

describe('GET /api/usage/summary', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq('https://kernel.test/api/usage/summary'));

    expect(res.status).toBe(401);
    expect(mocks.readUsageSummary).not.toHaveBeenCalled();
  });

  it("defaults did to the caller's own effective DID", async () => {
    await GET(makeReq('https://kernel.test/api/usage/summary'));

    expect(mocks.readUsageSummary).toHaveBeenCalledWith(expect.objectContaining({ principalDid: OWNER_DID }));
  });

  it('allows a registered agent (actingFor) to read its principal\'s summary', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: AGENT_DID, actingFor: OWNER_DID } });

    const res = await GET(makeReq(`https://kernel.test/api/usage/summary?did=${OWNER_DID}`));

    expect(res.status).toBe(200);
    expect(mocks.readUsageSummary).toHaveBeenCalledWith(expect.objectContaining({ principalDid: OWNER_DID }));
  });

  it('returns 403 for a did that does not match the effective DID', async () => {
    const res = await GET(makeReq('https://kernel.test/api/usage/summary?did=did:imajin:someone-else'));

    expect(res.status).toBe(403);
    expect(mocks.readUsageSummary).not.toHaveBeenCalled();
  });

  it('defaults window to the current month when absent', async () => {
    await GET(makeReq('https://kernel.test/api/usage/summary'));

    const call = mocks.readUsageSummary.mock.calls[0][0];
    expect(call.windowLabel).toMatch(/^\d{4}-\d{2}$/);
  });

  it('parses an explicit YYYY-MM window', async () => {
    await GET(makeReq('https://kernel.test/api/usage/summary?window=2026-08'));

    expect(mocks.readUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        windowLabel: '2026-08',
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-09-01T00:00:00.000Z'),
      }),
    );
  });

  it('parses an explicit date-range window', async () => {
    await GET(makeReq('https://kernel.test/api/usage/summary?window=2026-08-01..2026-08-15'));

    expect(mocks.readUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ from: new Date('2026-08-01T00:00:00.000Z'), to: new Date('2026-08-16T00:00:00.000Z') }),
    );
  });

  it('rejects a malformed window', async () => {
    const res = await GET(makeReq('https://kernel.test/api/usage/summary?window=not-a-window'));

    expect(res.status).toBe(400);
    expect(mocks.readUsageSummary).not.toHaveBeenCalled();
  });

  it('returns the summary body with a no-store cache header', async () => {
    const res = await GET(makeReq('https://kernel.test/api/usage/summary'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ did: OWNER_DID, currency: 'USD' });
  });

  it('returns 500 without leaking the underlying failure when the query throws', async () => {
    mocks.readUsageSummary.mockRejectedValueOnce(new Error('db down'));

    const res = await GET(makeReq('https://kernel.test/api/usage/summary'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Usage summary unavailable' });
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq('https://kernel.test/api/usage/summary'));
    expect(res.status).toBe(204);
  });
});
