import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OPERATOR_DID,
  OTHER_HUMAN_DID,
  GROUP_DID,
  operatorIdentity,
  otherHumanIdentity,
  agentActingForOperatorIdentity,
  operatorActingAsGroupIdentity,
  pendingApprovalCard,
} from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth, mockGetOperatorDid, mockList } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockList: vi.fn(),
}));

// #2359: the route's act-as context is computed by the real
// `isUnderActAs`/`resolveActingDid`, so keep the actual implementations
// and override only `requireAuth`.
vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return { ...actual, requireAuth: mockRequireAuth };
});

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

  // #2723: the Inbox is scoped to the SESSION DID — every principal lists the
  // rows addressed to them, and `isOperator` only reports who the node
  // operator is.
  it.each([
    // [label, identity factory, operator DID configured on the node, expected isOperator, expected inbox DID]
    ['the node operator', operatorIdentity, OPERATOR_DID, true, OPERATOR_DID],
    ['a non-operator principal (their own connector proposals)', otherHumanIdentity, OPERATOR_DID, false, OTHER_HUMAN_DID],
    ['the operator on a node with no operator configured', operatorIdentity, null, false, OPERATOR_DID],
    ['a principal on a node with no operator configured', otherHumanIdentity, null, false, OTHER_HUMAN_DID],
  ])('lists the session DID\u2019s own Inbox for %s (#2723)', async (_label, identity, configuredOperator, expectedIsOperator, expectedInboxDid) => {
    mockGetOperatorDid.mockResolvedValueOnce(configuredOperator);
    mockRequireAuth.mockResolvedValueOnce({ identity: identity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; approvals: unknown[] };

    expect(res.status).toBe(200);
    expect(body.isOperator).toBe(expectedIsOperator);
    expect(body.approvals).toHaveLength(1);
    expect(mockList).toHaveBeenCalledWith(expectedInboxDid, {});
  });

  it('returns an empty Inbox for a delegated agent acting for the operator — it has none (#2059 acceptance (d))', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: agentActingForOperatorIdentity() });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { isOperator: boolean; approvals: unknown[] };

    expect(body).toEqual({ isOperator: false, approvals: [] });
    expect(mockList).not.toHaveBeenCalled();
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

  // #2359: deciding is self-only, but LISTING stays readable under act-as —
  // hiding the queue would only make the act-as state harder to notice.
  describe('act-as (#2359)', () => {
    it('still lists the operator’s proposals for a session under act-as', async () => {
      mockRequireAuth.mockResolvedValueOnce({ identity: operatorActingAsGroupIdentity() });

      const res = await GET(makeReq() as Parameters<typeof GET>[0]);
      const body = (await res.json()) as { isOperator: boolean; approvals: unknown[] };

      expect(res.status).toBe(200);
      expect(body.isOperator).toBe(true);
      expect(body.approvals).toHaveLength(1);
      expect(mockList).toHaveBeenCalledWith(OPERATOR_DID, {});
    });

    it('reports the act-as context so the panel can disable its controls with an explanation', async () => {
      mockRequireAuth.mockResolvedValueOnce({ identity: operatorActingAsGroupIdentity() });

      const res = await GET(makeReq() as Parameters<typeof GET>[0]);
      const body = (await res.json()) as { actAs: { sessionDid: string; actingDid: string } | null };

      expect(body.actAs).toEqual({ sessionDid: OPERATOR_DID, actingDid: GROUP_DID });
    });

    it('reports actAs: null for the operator’s own un-borrowed session', async () => {
      mockRequireAuth.mockResolvedValueOnce({ identity: operatorIdentity() });

      const res = await GET(makeReq() as Parameters<typeof GET>[0]);
      const body = (await res.json()) as { actAs: unknown };

      expect(body.actAs).toBeNull();
    });
  });
});
