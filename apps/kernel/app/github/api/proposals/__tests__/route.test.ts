import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockRequireAuth,
  mockDbSelect,
  mockSelectWhere,
  mockSelectOrderBy,
  mockSelectLimit,
} = vi.hoisted(() => {
  const mockSelectLimit    = vi.fn().mockResolvedValue([]);
  const mockSelectOrderBy  = vi.fn(() => ({ limit: mockSelectLimit }));
  const mockSelectWhere    = vi.fn(() => ({ orderBy: mockSelectOrderBy }));
  const mockSelectFrom     = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbSelect       = vi.fn(() => ({ from: mockSelectFrom }));
  const mockRequireAuth    = vi.fn();
  return { mockRequireAuth, mockDbSelect, mockSelectWhere, mockSelectOrderBy, mockSelectLimit };
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  githubActionProposals: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  desc: (col: unknown) => ({ desc: col }),
  inArray: (...args: unknown[]) => ({ inArray: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// ─── Subject ──────────────────────────────────────────────────────────────────

import { GET } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID  = 'did:imajin:owner-123';
const BASE_URL   = 'https://test.imajin.ai/github/api/proposals';

const PENDING_PROPOSAL = {
  id: 'proposal_1',
  ownerDid: OWNER_DID,
  agentDid: null,
  scope: 'github:write',
  tool: 'github_update_issue',
  riskTier: 'mutate',
  target: 'ima-jin/imajin-ai#42',
  argsSummary: 'state: closed',
  status: 'pending',
  approvedUntil: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeReq(url = BASE_URL): Request {
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectLimit.mockResolvedValue([]);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /github/api/proposals (#1429)', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it('returns proposals for the signed-in owner', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockSelectLimit.mockResolvedValueOnce([PENDING_PROPOSAL]);

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(200);
    const body = await res.json() as { proposals: typeof PENDING_PROPOSAL[] };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0].id).toBe('proposal_1');
  });

  it('defaults to pending,approved statuses', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockSelectLimit.mockResolvedValueOnce([]);

    await GET(makeReq() as Parameters<typeof GET>[0]);
    // inArray was called with the default statuses
    const whereArgs = mockSelectWhere.mock.calls[0][0] as { and: unknown[] };
    const inArrayCall = (whereArgs.and as { inArray?: unknown[] }[]).find((a) => 'inArray' in a);
    const statuses = (inArrayCall as { inArray: [unknown, string[]] }).inArray[1];
    expect(statuses).toContain('pending');
    expect(statuses).toContain('approved');
    expect(statuses).not.toContain('done');
  });

  it('honours explicit ?status= query param', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockSelectLimit.mockResolvedValueOnce([]);

    await GET(makeReq(`${BASE_URL}?status=done`) as Parameters<typeof GET>[0]);
    const whereArgs = mockSelectWhere.mock.calls[0][0] as { and: unknown[] };
    const inArrayCall = (whereArgs.and as { inArray?: unknown[] }[]).find((a) => 'inArray' in a);
    const statuses = (inArrayCall as { inArray: [unknown, string[]] }).inArray[1];
    expect(statuses).toEqual(['done']);
  });

  it('returns 400 when all supplied statuses are invalid', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    const res = await GET(makeReq(`${BASE_URL}?status=invalid`) as Parameters<typeof GET>[0]);
    expect(res.status).toBe(400);
  });

  it('caps limit at 200', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockSelectLimit.mockResolvedValueOnce([]);

    await GET(makeReq(`${BASE_URL}?limit=9999`) as Parameters<typeof GET>[0]);
    expect(mockSelectLimit).toHaveBeenCalledWith(200);
  });
});
