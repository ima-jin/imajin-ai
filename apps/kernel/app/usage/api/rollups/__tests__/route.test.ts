import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockSelectLimit, mockSelectWhere, mockDbSelect } = vi.hoisted(() => {
  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  const mockSelectOrderBy = vi.fn(() => ({ limit: mockSelectLimit }));
  const mockSelectWhere = vi.fn(() => ({ orderBy: mockSelectOrderBy }));
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbSelect = vi.fn(() => ({ from: mockSelectFrom }));
  return { mockRequireAuth: vi.fn(), mockSelectLimit, mockSelectWhere, mockDbSelect };
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
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  desc: (col: unknown) => ({ desc: col }),
  gte: (...args: unknown[]) => ({ gte: args }),
  lte: (...args: unknown[]) => ({ lte: args }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://agri.example' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { GET, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';
const BASE_URL = 'https://test.imajin.ai/usage/api/rollups';

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(url = BASE_URL): RouteRequest {
  return { url, headers: new Headers() } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  mockSelectLimit.mockResolvedValue([]);
});

describe('GET /usage/api/rollups', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('defaults `did` to the caller\'s own effective DID', async () => {
    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    expect(mockSelectWhere).toHaveBeenCalledWith(
      expect.objectContaining({ and: expect.arrayContaining([{ eq: ['subject_did', OWNER_DID] }]) }),
    );
  });

  it('returns 403 when the did query param does not match the caller (owner-only)', async () => {
    const res = await GET(makeReq(`${BASE_URL}?did=did:imajin:someone-else`));

    expect(res.status).toBe(403);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('rejects an invalid `from` timestamp', async () => {
    const res = await GET(makeReq(`${BASE_URL}?from=not-a-date`));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid `to` timestamp', async () => {
    const res = await GET(makeReq(`${BASE_URL}?to=not-a-date`));
    expect(res.status).toBe(400);
  });

  it('maps attestation rows to a flattened rollup shape', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      {
        id: 'att_1',
        subjectDid: OWNER_DID,
        issuerDid: 'did:imajin:node',
        issuedAt: new Date('2026-09-02T02:00:00.000Z'),
        payload: {
          windowStart: '2026-09-01T00:00:00.000Z',
          windowEnd: '2026-09-02T00:00:00.000Z',
          totalCostEstimateUsd: 2.5,
          breakdown: [{ resource: 'model:xai/grok-4', source: 'inference-passthrough', quantity: 100, unit: 'tokens', costEstimateUsd: 2.5 }],
        },
      },
    ]);

    const res = await GET(makeReq());
    const body = (await res.json()) as { rollups: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(body.rollups).toHaveLength(1);
    expect(body.rollups[0]).toMatchObject({
      id: 'att_1',
      principalDid: OWNER_DID,
      issuerDid: 'did:imajin:node',
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-02T00:00:00.000Z',
      totalCostEstimateUsd: 2.5,
      issuedAt: '2026-09-02T02:00:00.000Z',
    });
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });

  it('returns 500 when the query throws', async () => {
    mockSelectLimit.mockImplementationOnce(() => {
      throw new Error('DB unavailable');
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});
