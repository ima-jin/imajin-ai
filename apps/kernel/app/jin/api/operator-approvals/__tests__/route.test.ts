import { describe, it, expect, vi, beforeEach } from 'vitest';
import { backfillReachApprovals } from '@/src/lib/notify/reach-approvals';
import { reachActAsPrincipal } from '@/src/lib/notify/reach-approval-authority';
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

const { mockRequireAuth, mockGetOperatorDid, mockList, mockGroupMember, mockCount } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockList: vi.fn(),
  mockGroupMember: vi.fn(),
  mockCount: vi.fn(),
}));
vi.mock('@/src/lib/auth/group-membership', () => ({ isActiveGroupMember: mockGroupMember }));
vi.mock('@/src/lib/notify/approval-inbox-count', () => ({ countInboxApprovals: mockCount }));

// #2359: the route's act-as context is computed by the real
// `isUnderActAs`/`resolveActingDid`, so keep the actual implementations
// and override only `requireAuth`.
vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return { ...actual, requireAuth: mockRequireAuth };
});
describe('count-only Inbox projection (#2970)', () => {
  it.each([
    ['personal', operatorIdentity, OPERATOR_DID],
    ['acting', operatorActingAsGroupIdentity, GROUP_DID],
  ])('counts the %s Inbox without loading cards or running recovery', async (_label, identity, did) => {
    const session = identity();
    mockRequireAuth.mockResolvedValue({ identity: session });
    vi.mocked(reachActAsPrincipal).mockResolvedValue(session.actingAs ?? null);
    const req = makeReq('?view=acting&count=true&source=reach&did=did:imajin:untrusted');
    const res = await GET(req as Parameters<typeof GET>[0]);
    expect(mockRequireAuth).toHaveBeenCalledWith(req, { service: 'jin' });
    expect(mockCount).toHaveBeenCalledWith(did, { source: 'reach', sharedReachPrincipal: session.actingAs ?? null });
    expect(await res.json()).toEqual({
      isOperator: true, pending: 120, canAccess: true,
      ...(session.actingAs ? { personalInbox: { pending: 120, handle: null } } : {}),
    });
    expect(mockList).not.toHaveBeenCalled();
    expect(backfillReachApprovals).not.toHaveBeenCalled();
  });

  it('retains the default session projection plus verified shared Reach cards', async () => {
    mockRequireAuth.mockResolvedValue({ identity: operatorActingAsGroupIdentity() });
    vi.mocked(reachActAsPrincipal).mockResolvedValue(GROUP_DID);
    const res = await GET(makeReq('?count=true') as Parameters<typeof GET>[0]);
    expect(await res.json()).toEqual({ isOperator: true, pending: 120 });
    expect(mockCount).toHaveBeenCalledWith(OPERATOR_DID, { sharedReachPrincipal: GROUP_DID });
  });

  it.each([
    [operatorIdentity, 0, true],
    [otherHumanIdentity, 0, false],
    [otherHumanIdentity, 1, true],
    [operatorActingAsGroupIdentity, 0, true],
  ])('preserves console visibility independently of pending count', async (identity, total, canAccess) => {
    mockRequireAuth.mockResolvedValue({ identity: identity() });
    mockCount.mockResolvedValue({ pending: 0, total });
    const res = await GET(makeReq('?view=acting&count=true') as Parameters<typeof GET>[0]);
    expect(await res.json()).toMatchObject({ pending: 0, canAccess });
  });

  it.each([401, 403])('propagates auth/service refusal %s without querying', async status => {
    mockRequireAuth.mockResolvedValue({ error: 'Denied', status });
    const res = await GET(makeReq('?view=acting&count=true') as Parameters<typeof GET>[0]);
    expect(res.status).toBe(status);
    expect(mockCount).not.toHaveBeenCalled();
  });

  it.each(['member', 'removed'])('rejects %s acting authority before counting', async authority => {
    mockRequireAuth.mockResolvedValue({
      identity: { ...operatorActingAsGroupIdentity(), ...(authority === 'member' ? { actingAsRole: 'member' } : {}) },
    });
    mockGroupMember.mockResolvedValue(authority !== 'removed');
    const res = await GET(makeReq('?view=acting&count=true') as Parameters<typeof GET>[0]);
    expect(res.status).toBe(403);
    expect(mockCount).not.toHaveBeenCalled();
  });

  it.each(['?count=true', '?view=acting&count=true'])('gives delegates no count for %s', async query => {
    mockRequireAuth.mockResolvedValue({ identity: agentActingForOperatorIdentity() });
    const res = await GET(makeReq(query) as Parameters<typeof GET>[0]);
    expect(await res.json()).toEqual({
      isOperator: false, pending: 0, ...(query.includes('view=acting') ? { canAccess: false } : {}),
    });
    expect(mockCount).not.toHaveBeenCalled();
  });
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
  mockCount.mockResolvedValue({ pending: 120, total: 125 });
  vi.mocked(reachActAsPrincipal).mockResolvedValue(null);
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
  it('reads retained decision cards in the authenticated scope without consulting an external source', async () => {
    mockRequireAuth.mockResolvedValue({ identity: operatorIdentity() });
    const cards = ['pending', 'approved', 'applied'].map(status => pendingApprovalCard({
      proposalId: status, source: 'decision', kind: 'decision:card', status,
      actionable: status === 'pending',
    }));
    mockList.mockResolvedValue(cards);
    const response = await GET(makeReq('?view=acting&source=decision&history=true&did=did:foreign') as Parameters<typeof GET>[0]);
    expect(await response.json()).toMatchObject({ approvals: cards });
    expect(mockList).toHaveBeenCalledWith(OPERATOR_DID, { source: 'decision' });
  });
  it('returns only actionable cards by default and explicitly retrieves retained history in the same scope', async () => {
    mockRequireAuth.mockResolvedValue({ identity: operatorIdentity() });
    const active = pendingApprovalCard({ proposalId: 'active' });
    const history = pendingApprovalCard({ proposalId: 'history', status: 'expired', actionable: false });
    mockList.mockResolvedValue([active, history]);
    const current = await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(await current.json()).toMatchObject({ approvals: [active], hasHistory: true });
    const all = await GET(makeReq('?history=true') as Parameters<typeof GET>[0]);
    expect(await all.json()).toMatchObject({ approvals: [active, history], hasHistory: true });
    expect(mockList.mock.calls.every(([did]) => did === OPERATOR_DID)).toBe(true);
  });
  describe('personal attention while acting (#3017)', () => {
    it.each(['?view=acting', '?view=acting&count=true'])('returns only the actor own count and handle in %s', async query => {
      mockRequireAuth.mockResolvedValue({ identity: { ...operatorActingAsGroupIdentity(), handle: 'ryan' } });
      mockCount.mockImplementation(async (did: string) => ({ pending: did === OPERATOR_DID ? 2 : 3, total: 3 }));
      mockList.mockResolvedValue([]);
      const response = await GET(makeReq(`${query}&did=${OTHER_HUMAN_DID}&source=github`) as Parameters<typeof GET>[0]);
      const body = await response.json();
      expect(body.personalInbox).toEqual({ pending: 2, handle: 'ryan' });
      expect(mockCount).toHaveBeenCalledWith(OPERATOR_DID);
      expect(mockCount).not.toHaveBeenCalledWith(OTHER_HUMAN_DID, expect.anything());
      expect(mockList.mock.calls.every(([did]) => did === GROUP_DID)).toBe(true);
      expect(body.approvals ?? []).toEqual([]);
    });

    it('never gives another org controller the operator count', async () => {
      mockRequireAuth.mockResolvedValue({ identity: {
        ...otherHumanIdentity(), actingAs: GROUP_DID, actingAsRole: 'admin',
      } });
      mockCount.mockImplementation(async (did: string) => ({ pending: did === OPERATOR_DID ? 9 : 0, total: 0 }));
      mockList.mockResolvedValue([]);
      const response = await GET(makeReq('?view=acting') as Parameters<typeof GET>[0]);
      expect((await response.json()).personalInbox).toBeUndefined();
      expect(mockCount).toHaveBeenCalledTimes(1);
      expect(mockCount).toHaveBeenCalledWith(OTHER_HUMAN_DID);
    });

    it.each([
      operatorIdentity(),
      { ...operatorActingAsGroupIdentity(), subtype: 'agent' },
      { ...operatorActingAsGroupIdentity(), actingAs: OPERATOR_DID },
    ])('omits personal attention outside a human borrowing a different identity', async identity => {
      mockRequireAuth.mockResolvedValue({ identity });
      const response = await GET(makeReq('?view=acting') as Parameters<typeof GET>[0]);
      expect((await response.json()).personalInbox).toBeUndefined();
      expect(mockCount).not.toHaveBeenCalled();
    });
  });
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
