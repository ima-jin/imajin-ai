import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/src/lib/notify/reach-approvals', () => ({ backfillReachApprovals: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/notify/reach-approval-authority', () => ({ reachActAsPrincipal: vi.fn().mockResolvedValue(null) }));
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

const { mockRequireAuth, mockGetOperatorDid, mockList, mockGroupMember } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockList: vi.fn(),
  mockGroupMember: vi.fn(),
}));
vi.mock('@/src/lib/auth/group-membership', () => ({ isActiveGroupMember: mockGroupMember }));

// #2359: the route's act-as context is computed by the real
// `isUnderActAs`/`resolveActingDid`, so keep the actual implementations
// and override only `requireAuth`.
vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return { ...actual, requireAuth: mockRequireAuth };
});


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
  mockGroupMember.mockResolvedValue(true);
});

describe('OPTIONS /jin/api/operator-approvals', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Acting-As');
  });
  it.each([
    ['https://client.imajin.ai', 'https://client.imajin.ai'],
    ['https://untrusted.example', ''],
  ])('retains the origin allowlist for %s', async (origin, allowed) => {
    const req = new Request('https://test.imajin.ai/jin/api/operator-approvals?view=acting', {
      headers: { Origin: origin, 'Access-Control-Request-Headers': 'X-Acting-As' },
    });
    const response = OPTIONS(req as Parameters<typeof OPTIONS>[0]);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(allowed);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Acting-As');
  });
});

describe('GET /jin/api/operator-approvals (#2059)', () => {
  describe('acting read projection (#2952)', () => {
    it.each(['agent', 'maintainer', 'member', undefined])('refuses actingAsRole=%s before reading an Inbox', async role => {
      mockRequireAuth.mockResolvedValueOnce({
        identity: { ...operatorActingAsGroupIdentity(), actingAsRole: role },
      });
      const res = await GET(makeReq('?view=acting') as Parameters<typeof GET>[0]);
      expect(res.status).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
      expect(mockGroupMember).not.toHaveBeenCalled();
    });

    it('refuses personal targets and removed group membership', async () => {
      mockRequireAuth.mockResolvedValueOnce({ identity: operatorActingAsGroupIdentity() });
      mockGroupMember.mockResolvedValueOnce(false);
      const res = await GET(makeReq('?view=acting') as Parameters<typeof GET>[0]);
      expect(res.status).toBe(403);
      expect(mockGroupMember).toHaveBeenCalledWith(GROUP_DID, OPERATOR_DID);
      expect(mockList).not.toHaveBeenCalled();
    });
    it('reads only the validated organization Inbox and retains the self-only context', async () => {
      mockRequireAuth.mockResolvedValueOnce({ identity: operatorActingAsGroupIdentity() });
      const req = makeReq('?view=acting&source=github');
      const res = await GET(req as Parameters<typeof GET>[0]);
      expect(mockRequireAuth).toHaveBeenCalledWith(req, { service: 'jin' });
      expect(mockList).toHaveBeenCalledWith(GROUP_DID, { source: 'github' });
      expect(await res.json()).toMatchObject({
        canAccess: true, actAs: { sessionDid: OPERATOR_DID, actingDid: GROUP_DID },
      });
    });

    it('refuses invalid or service-restricted act-as without reading either Inbox', async () => {
      mockRequireAuth.mockResolvedValueOnce({ error: 'Not authorized to act as this group', status: 403 });
      const res = await GET(makeReq('?view=acting') as Parameters<typeof GET>[0]);
      expect(res.status).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    });

    it('does not let a delegated agent read an acting Inbox', async () => {
      mockRequireAuth.mockResolvedValueOnce({ identity: agentActingForOperatorIdentity() });
      const res = await GET(makeReq('?view=acting') as Parameters<typeof GET>[0]);
      expect(await res.json()).toEqual({ isOperator: false, canAccess: false, approvals: [] });
      expect(mockList).not.toHaveBeenCalled();
    });

    it.each([
      ['operator with empty Inbox', operatorIdentity, [], true],
      ['principal with empty Inbox', otherHumanIdentity, [], false],
      ['principal with addressed cards', otherHumanIdentity, [pendingApprovalCard()], true],
      ['controller with empty org Inbox', operatorActingAsGroupIdentity, [], true],
    ])('follows existing console visibility for %s', async (_label, identity, cards, canAccess) => {
      mockRequireAuth.mockResolvedValueOnce({ identity: identity() });
      mockList.mockResolvedValueOnce(cards);
      const res = await GET(makeReq('?view=acting&did=did:imajin:untrusted') as Parameters<typeof GET>[0]);
      expect(await res.json()).toMatchObject({ canAccess });
      expect(mockList).toHaveBeenCalledWith(identity().actingAs ?? identity().id, {});
    });
  });
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
