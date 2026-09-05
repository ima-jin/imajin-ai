import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockSelectLimit, mockSelectWhere, mockDbSelect } = vi.hoisted(() => {
  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  const mockSelectOrderBy = vi.fn(() => ({ limit: mockSelectLimit }));
  const mockSelectWhere = vi.fn(() => ({ orderBy: mockSelectOrderBy }));
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbSelect = vi.fn(() => ({ from: mockSelectFrom }));
  return { mockSelectLimit, mockSelectWhere, mockDbSelect };
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  attestations: {
    id: 'id',
    type: 'type',
    subjectDid: 'subject_did',
    issuerDid: 'issuer_did',
    revokedAt: 'revoked_at',
    issuedAt: 'issued_at',
    payload: 'payload',
    signature: 'signature',
    contextId: 'context_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  desc: (col: unknown) => ({ desc: col }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://example.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

vi.mock('@/src/lib/usage/rollup', () => ({
  contextIdFor: (did: string, windowStart: Date) => `usage-rollup:${did}:${windowStart.toISOString().slice(0, 10)}`,
}));

import { GET, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';
const BASE_URL = `https://kernel.test/api/usage/rollup/${encodeURIComponent(OWNER_DID)}/latest`;

type RouteParams = { params: Promise<{ did: string }> };

function makeReq(url = BASE_URL): NextRequest {
  return new NextRequest(url);
}

function makeParams(did: string = encodeURIComponent(OWNER_DID)): RouteParams {
  return { params: Promise.resolve({ did }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectLimit.mockResolvedValue([]);
});

describe('GET /api/usage/rollup/{did}/latest (public)', () => {
  it('requires no authentication at all', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      { id: 'att_1', subjectDid: OWNER_DID, issuerDid: 'did:imajin:node', signature: 'sig', issuedAt: new Date('2026-08-02T00:00:00.000Z'), payload: {} },
    ]);

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(200);
  });

  it('returns 404 when no rollup attestation exists for the DID', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(404);
  });

  it('returns the attestation exactly as stored, including its signature and issuer', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      {
        id: 'att_1',
        subjectDid: OWNER_DID,
        issuerDid: 'did:imajin:node',
        signature: 'deadbeef',
        issuedAt: new Date('2026-08-02T00:00:00.000Z'),
        payload: {
          windowStart: '2026-08-01T00:00:00.000Z',
          windowEnd: '2026-08-02T00:00:00.000Z',
          totalCostEstimateUsd: 4.2,
          breakdown: [{ resource: 'model:anthropic/claude', source: 's', quantity: 1, unit: 'tokens', costEstimateUsd: 4.2 }],
        },
      },
    ]);

    const res = await GET(makeReq(), makeParams());
    const body = await res.json();

    expect(body).toEqual({
      id: 'att_1',
      issuerDid: 'did:imajin:node',
      subjectDid: OWNER_DID,
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: '2026-08-02T00:00:00.000Z',
      totalCostEstimateUsd: 4.2,
      breakdown: [{ resource: 'model:anthropic/claude', source: 's', quantity: 1, unit: 'tokens', costEstimateUsd: 4.2 }],
      signature: 'deadbeef',
      signedAt: '2026-08-02T00:00:00.000Z',
    });
  });

  it('filters on the specific contextId when ?window=YYYY-MM-DD is given', async () => {
    await GET(makeReq(`${BASE_URL}?window=2026-08-01`), makeParams());

    expect(mockSelectWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        and: expect.arrayContaining([{ eq: ['context_id', `usage-rollup:${OWNER_DID}:2026-08-01`] }]),
      }),
    );
  });

  it('rejects a malformed window date', async () => {
    const res = await GET(makeReq(`${BASE_URL}?window=not-a-date`), makeParams());
    expect(res.status).toBe(400);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('marks the response as no-store', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      { id: 'att_1', subjectDid: OWNER_DID, issuerDid: 'did:imajin:node', signature: 'sig', issuedAt: new Date(), payload: {} },
    ]);

    const res = await GET(makeReq(), makeParams());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 500 without leaking the underlying failure when the query throws', async () => {
    mockSelectLimit.mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(500);
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});
