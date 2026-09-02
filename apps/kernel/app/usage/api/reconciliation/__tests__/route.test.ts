import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockResolveEffectiveDid, mockReadReconciliation } = vi.hoisted(() => ({
  mockResolveEffectiveDid: vi.fn(),
  mockReadReconciliation: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ resolveEffectiveDid: mockResolveEffectiveDid }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://example.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/usage/reconciliation', () => ({ readReconciliation: mockReadReconciliation }));

import { GET, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';

function makeReq(url: string): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: OWNER_DID, via: 'session', composedBy: null });
  mockReadReconciliation.mockResolvedValue([]);
});

describe('GET /usage/api/reconciliation (#1076 Stage 1)', () => {
  it('requires the infer:usage-read scope and fails closed on auth failure', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce({ ok: false, status: 401, error: 'Unauthorized' });

    const res = await GET(makeReq('https://kernel.test/usage/api/reconciliation'));

    expect(res.status).toBe(401);
    expect(mockReadReconciliation).not.toHaveBeenCalled();
    expect(mockResolveEffectiveDid).toHaveBeenCalledWith(expect.anything(), { scope: 'infer:usage-read' });
  });

  it("reads reconciliation rows scoped to the caller's own DID, never a query-supplied one", async () => {
    const res = await GET(makeReq('https://kernel.test/usage/api/reconciliation?provider=anthropic&from=2026-08-01&to=2026-08-15'));

    expect(res.status).toBe(200);
    expect(mockReadReconciliation).toHaveBeenCalledWith({
      principalDid: OWNER_DID,
      provider: 'anthropic',
      from: new Date('2026-08-01'),
      to: new Date('2026-08-15'),
    });
  });

  it('omits provider/from/to when absent from the query string', async () => {
    await GET(makeReq('https://kernel.test/usage/api/reconciliation'));

    expect(mockReadReconciliation).toHaveBeenCalledWith({
      principalDid: OWNER_DID,
      provider: undefined,
      from: undefined,
      to: undefined,
    });
  });

  it('ignores an unparseable from/to rather than failing the request', async () => {
    await GET(makeReq('https://kernel.test/usage/api/reconciliation?from=not-a-date'));

    expect(mockReadReconciliation).toHaveBeenCalledWith(expect.objectContaining({ from: undefined }));
  });

  it('returns the rows the query resolves', async () => {
    mockReadReconciliation.mockResolvedValueOnce([{ date: '2026-08-01', provider: 'anthropic', model: null }]);

    const res = await GET(makeReq('https://kernel.test/usage/api/reconciliation'));
    const body = await res.json() as { rows: unknown[] };

    expect(body.rows).toEqual([{ date: '2026-08-01', provider: 'anthropic', model: null }]);
  });

  it('returns 500 without leaking the underlying failure when the query throws', async () => {
    mockReadReconciliation.mockRejectedValueOnce(new Error('connection reset'));

    const res = await GET(makeReq('https://kernel.test/usage/api/reconciliation'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Usage reconciliation unavailable' });
  });

  it('marks the response as no-store', async () => {
    const res = await GET(makeReq('https://kernel.test/usage/api/reconciliation'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq('https://kernel.test/usage/api/reconciliation'));
    expect(res.status).toBe(204);
  });
});
