import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth, mockGetOperatorDid, mockListGrantsForOperator } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockListGrantsForOperator: vi.fn(),
}));

const OPERATOR_DID = 'did:imajin:operator';

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

// operator-approvals.ts imports node-identity.ts, which calls getClient() at
// module scope (requires DATABASE_URL). Stub it so importOriginal() below can
// load the real (pure) isOperatorIdentity code without a DB — same pattern as
// jin/api/operator-approvals's own route test.
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));

vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});

vi.mock('@/src/lib/jin/grants-lane', () => ({
  listGrantsForOperator: mockListGrantsForOperator,
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { GET, OPTIONS } from '../route';

function makeReq(): Request {
  return new Request('https://test.imajin.ai/jin/api/grants');
}

function operatorIdentity() {
  return { id: OPERATOR_DID, actingFor: undefined };
}

function otherHumanIdentity() {
  return { id: 'did:imajin:someone-else', actingFor: undefined };
}

function agentActingForOperatorIdentity() {
  return { id: 'did:imajin:jin', actingFor: OPERATOR_DID };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockListGrantsForOperator.mockResolvedValue([{ id: 'auth-grant:g1' }]);
});

describe('OPTIONS /jin/api/grants', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('GET /jin/api/grants (#2292)', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
    expect(mockListGrantsForOperator).not.toHaveBeenCalled();
  });

  it('returns the operator\u2019s grants for the operator identity', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: operatorIdentity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; grants: unknown[] };

    expect(res.status).toBe(200);
    expect(body.isOperator).toBe(true);
    expect(body.grants).toHaveLength(1);
    expect(mockListGrantsForOperator).toHaveBeenCalledWith(OPERATOR_DID);
  });

  it('returns an empty list for a non-operator human \u2014 no card, no data', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: otherHumanIdentity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; grants: unknown[] };

    expect(res.status).toBe(200);
    expect(body).toEqual({ isOperator: false, grants: [] });
    expect(mockListGrantsForOperator).not.toHaveBeenCalled();
  });

  it('returns an empty list for an agent acting for the operator', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: agentActingForOperatorIdentity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; grants: unknown[] };

    expect(body).toEqual({ isOperator: false, grants: [] });
    expect(mockListGrantsForOperator).not.toHaveBeenCalled();
  });

  it('returns an empty list when no operator DID is configured at all', async () => {
    mockGetOperatorDid.mockResolvedValueOnce(null);
    mockRequireAuth.mockResolvedValueOnce({ identity: operatorIdentity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; grants: unknown[] };

    expect(body).toEqual({ isOperator: false, grants: [] });
  });
});
