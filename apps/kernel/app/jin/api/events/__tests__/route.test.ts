import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Identity } from '@imajin/auth';

const { mockRequireAuth, mockList, mockGroupMember } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockList: vi.fn(),
  mockGroupMember: vi.fn(),
}));

vi.mock('@imajin/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@imajin/auth')>();
  return { ...actual, requireAuth: mockRequireAuth };
});

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/jin/record-events', () => ({
  listRecordEventsForPrincipal: mockList,
}));
vi.mock('@/src/lib/auth/group-membership', () => ({ isActiveGroupMember: mockGroupMember }));

import { GET, OPTIONS } from '../route';

const HUMAN_DID = 'did:imajin:human-1';
const AGENT_DID = 'did:imajin:agent-1';

function makeReq(query = '', headers: Record<string, string> = {}): Request {
  return new Request(`https://test.imajin.ai/jin/api/events${query}`, { headers });
}

function humanIdentity(): Identity {
  return { id: HUMAN_DID, scope: 'actor', subtype: 'human', tier: 'established' };
}

function agentActingForIdentity(): Identity {
  return { id: AGENT_DID, scope: 'actor', subtype: 'agent', tier: 'established', actingFor: HUMAN_DID, actingForRole: 'agent' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: humanIdentity() });
  mockGroupMember.mockResolvedValue(true);
  mockList.mockResolvedValue({ events: [], total: 0, limit: 50, offset: 0 });
});

describe('OPTIONS /jin/api/events', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });


});

describe('GET /jin/api/events (#2289)', () => {
  it('retains jin Record access but suppresses grant refs without auth-service access', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: {
      ...humanIdentity(), actingAs: 'did:imajin:org', actingAsRole: 'admin',
    } }).mockResolvedValueOnce({ error: 'auth service denied', status: 403 });
    expect((await GET(makeReq() as Parameters<typeof GET>[0])).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('did:imajin:org', {}, { organization: true, canReadGrants: false });
  });
  it('returns 401 when unauthenticated, never calling the service', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });
    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('scopes to the caller\u2019s own DID by default (no admin gate)', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: humanIdentity() });
    await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(mockList).toHaveBeenCalledWith(HUMAN_DID, {});
  });

  it('never selects the read principal via X-Acting-For', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: agentActingForIdentity() });
    await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(mockList).toHaveBeenCalledWith(AGENT_DID, {}, { canReadGrants: false, canReadApprovals: false });
    expect(mockRequireAuth).toHaveBeenCalledWith(expect.any(Request), { service: 'jin' });
  });

  it.each(['owner', 'admin'])('selects the validated org for a human %s', async (role) => {
    mockRequireAuth.mockResolvedValueOnce({ identity: {
      ...humanIdentity(), actingAs: 'did:imajin:org', actingAsRole: role,
    } });
    expect((await GET(makeReq() as Parameters<typeof GET>[0])).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('did:imajin:org', {}, { organization: true });
    expect(mockGroupMember).toHaveBeenCalledWith('did:imajin:org', HUMAN_DID);
    expect(mockRequireAuth).toHaveBeenCalledWith(expect.any(Request), { service: 'auth' });
  });

  it.each(['member', 'maintainer', 'agent', undefined])('denies act-as role %s before listing', async (role) => {
    mockRequireAuth.mockResolvedValueOnce({ identity: {
      ...humanIdentity(), actingAs: 'did:imajin:org', actingAsRole: role,
    } });
    expect((await GET(makeReq() as Parameters<typeof GET>[0])).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it.each([
    { subtype: 'agent' as const },
    { actingFor: HUMAN_DID },
  ])('denies an agent or mixed act-as/acting-for context (%j)', async (extra) => {
    mockRequireAuth.mockResolvedValueOnce({ identity: {
      ...humanIdentity(), actingAs: 'did:imajin:org', actingAsRole: 'owner', ...extra,
    } });
    expect((await GET(makeReq() as Parameters<typeof GET>[0])).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('denies a non-group act-as target even with an owner role hint', async () => {
    mockGroupMember.mockResolvedValueOnce(false);
    mockRequireAuth.mockResolvedValueOnce({ identity: {
      ...humanIdentity(), actingAs: 'did:imajin:personal', actingAsRole: 'owner',
    } });
    expect((await GET(makeReq() as Parameters<typeof GET>[0])).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('propagates a service-scoped auth refusal without a personal fallback', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authorized to act as this group', status: 403 });
    expect((await GET(makeReq() as Parameters<typeof GET>[0])).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('passes action/since/agent/grant filters through to the service', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: humanIdentity() });
    await GET(
      makeReq('?action=vault.key.minted&since=2026-01-01T00:00:00Z&agent=did:imajin:agent-x&grant=grant_1') as Parameters<
        typeof GET
      >[0],
    );
    expect(mockList).toHaveBeenCalledWith(HUMAN_DID, {
      action: 'vault.key.minted',
      since: '2026-01-01T00:00:00Z',
      agent: 'did:imajin:agent-x',
      grant: 'grant_1',
    });
  });

  it('passes limit/offset through when provided', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: humanIdentity() });
    await GET(makeReq('?limit=10&offset=20') as Parameters<typeof GET>[0]);
    expect(mockList).toHaveBeenCalledWith(HUMAN_DID, { limit: 10, offset: 20 });
  });

  it('omits limit/offset when absent or unparseable', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: humanIdentity() });
    await GET(makeReq('?limit=not-a-number') as Parameters<typeof GET>[0]);
    expect(mockList).toHaveBeenCalledWith(HUMAN_DID, {});
  });

  it('returns the service page verbatim on success', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: humanIdentity() });
    mockList.mockResolvedValueOnce({
      events: [{ id: 'evt_1', service: 'kernel', action: 'test.event' }],
      total: 1,
      limit: 50,
      offset: 0,
    });

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.events).toHaveLength(1);
  });

  it('returns 500 without leaking the raw error when the service throws', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: humanIdentity() });
    mockList.mockRejectedValueOnce(new Error('db exploded'));

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain('db exploded');
  });
});
