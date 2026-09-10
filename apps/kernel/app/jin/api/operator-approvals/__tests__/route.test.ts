import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OPERATOR_DID,
  operatorIdentity,
  otherHumanIdentity,
  agentActingForOperatorIdentity,
  pendingApprovalCard,
} from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth, mockGetOperatorDid, mockList } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

// operator-approvals.ts imports node-identity.ts, which calls getClient() at
// module scope (requires DATABASE_URL). Stub it so importOriginal() below can
// load the real (pure) validator/isOperatorIdentity code without a DB.
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));

vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});

vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  listApprovalsForOperator: mockList,
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { GET, OPTIONS } from '../route';

function makeReq(query = ''): Request {
  return new Request(`https://test.imajin.ai/jin/api/operator-approvals${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockList.mockResolvedValue([pendingApprovalCard()]);
});

describe('OPTIONS /jin/api/operator-approvals', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('GET /jin/api/operator-approvals (#2059)', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns the operator\u2019s proposals for the operator identity', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: operatorIdentity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; approvals: unknown[] };

    expect(res.status).toBe(200);
    expect(body.isOperator).toBe(true);
    expect(body.approvals).toHaveLength(1);
    expect(mockList).toHaveBeenCalledWith(OPERATOR_DID, {});
  });

  it('returns an empty list for a non-operator human — no card, no data (#2059 acceptance (c))', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: otherHumanIdentity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; approvals: unknown[] };

    expect(res.status).toBe(200);
    expect(body).toEqual({ isOperator: false, approvals: [] });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns an empty list for an agent acting for the operator (#2059 acceptance (d))', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: agentActingForOperatorIdentity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; approvals: unknown[] };

    expect(body).toEqual({ isOperator: false, approvals: [] });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns an empty list when no operator DID is configured at all', async () => {
    mockGetOperatorDid.mockResolvedValueOnce(null);
    mockRequireAuth.mockResolvedValueOnce({ identity: operatorIdentity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; approvals: unknown[] };

    expect(body).toEqual({ isOperator: false, approvals: [] });
  });

  it('passes ?source= through to listApprovalsForOperator as a filter (#2152)', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: operatorIdentity() });

    await GET(makeReq('?source=skill-workshop') as Parameters<typeof GET>[0]);

    expect(mockList).toHaveBeenCalledWith(OPERATOR_DID, { source: 'skill-workshop' });
  });

  it('omits the source filter when no ?source= query param is given', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: operatorIdentity() });

    await GET(makeReq() as Parameters<typeof GET>[0]);

    expect(mockList).toHaveBeenCalledWith(OPERATOR_DID, {});
  });
});
