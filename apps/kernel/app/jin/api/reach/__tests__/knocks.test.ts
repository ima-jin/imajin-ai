import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ReachBearerKnock } from '@/src/lib/access/reach-bearer-wire';
import { GET } from '../route';
import { POST } from '../knocks/[requestId]/block/route';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), list: vi.fn(), block: vi.fn(), envelopes: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));
vi.mock('@/src/lib/access/reach-bearer', () => ({
  listReachBearerKnocks: mocks.list, blockReachBearerKnock: mocks.block,
}));
vi.mock('@/src/lib/auth/reach-reply-store', () => ({ listReachInbox: mocks.envelopes }));
vi.mock('@/src/lib/auth/reach-reply-service', () => ({
  isReachPrincipal: (identity: { scope: string; subtype: string; actingAs?: string; actingFor?: string }) =>
    identity.scope === 'actor' && identity.subtype === 'human' && !identity.actingAs && !identity.actingFor,
}));

const identity = { id: 'did:imajin:owner', scope: 'actor', subtype: 'human' };
const knock: ReachBearerKnock = {
  requestId: 'request_1', requesterDid: 'did:imajin:agent', principalDid: identity.id,
  agentLabel: 'Research assistant',
  onBehalfOf: { platform: 'foreign', externalRef: 'someone', selfDescription: 'An UNVERIFIED claim' },
  claimVerified: false, status: 'active', issuedAt: '2026-10-17T00:00:00.000Z',
  expiresAt: '2026-10-18T00:00:00.000Z', hardCapAt: '2026-10-24T00:00:00.000Z',
};
const getRequest = () => new NextRequest('https://example.test/jin/api/reach');
const blockRequest = () => new NextRequest('https://example.test/jin/api/reach/knocks/request_1/block', {
  method: 'POST', body: JSON.stringify({ principalDid: 'attacker', requesterDid: 'attacker' }),
});
const props = () => ({ params: Promise.resolve({ requestId: knock.requestId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ identity });
  mocks.list.mockResolvedValue([knock]);
  mocks.block.mockResolvedValue(true);
  mocks.envelopes.mockResolvedValue([]);
});

describe('reach knock owner API', () => {
  it('lists owner-scoped, allowlisted metadata without credentials or hashes', async () => {
    mocks.list.mockResolvedValue([{
      ...knock, token: 'secret', bearer: 'secret', tokenHash: 'hash', claimVerified: true,
      onBehalfOf: { ...knock.onBehalfOf, token: 'nested-secret' },
    }]);
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principalDid: identity.id, envelopes: [], knocks: [knock] });
    expect(mocks.list).toHaveBeenCalledWith(identity.id);
    expect(mocks.envelopes).toHaveBeenCalledWith({ principalDid: identity.id });
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { sessionOnly: true });
  });

  it('omits absent optional claim description and retains existing envelopes', async () => {
    const withoutDescription = { ...knock, onBehalfOf: { platform: 'foreign', externalRef: 'someone' } };
    mocks.list.mockResolvedValue([withoutDescription]);
    mocks.envelopes.mockResolvedValue([{ reachId: 'existing' }]);
    expect(await (await GET(getRequest())).json()).toEqual({
      principalDid: identity.id, envelopes: [{ reachId: 'existing' }], knocks: [withoutDescription],
    });
  });

  it('blocks only the request id using the authenticated owner, never body identity', async () => {
    const response = await POST(blockRequest(), props());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ blocked: true });
    expect(mocks.block).toHaveBeenCalledTimes(1);
    expect(mocks.block).toHaveBeenCalledWith({ principalDid: identity.id, requestId: knock.requestId });
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { sessionOnly: true });
  });

  it.each(['missing', 'not owned'])('returns 404 when the knock is %s', async () => {
    mocks.block.mockResolvedValue(false);
    const response = await POST(blockRequest(), props());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Reach knock not found' });
  });

  it.each(['list', 'block'])('rejects unauthenticated %s without storage access', async mode => {
    mocks.auth.mockResolvedValue({ error: 'User session required', status: 401 });
    const response = mode === 'list' ? await GET(getRequest()) : await POST(blockRequest(), props());
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.block).not.toHaveBeenCalled();
  });

  it.each([
    { ...identity, subtype: 'agent' }, { ...identity, scope: 'business' },
    { ...identity, actingAs: 'did:group' }, { ...identity, actingFor: identity.id },
  ])('rejects non-direct-human callers on both routes', async caller => {
    mocks.auth.mockResolvedValue({ identity: caller });
    expect((await GET(getRequest())).status).toBe(403);
    expect((await POST(blockRequest(), props())).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.block).not.toHaveBeenCalled();
  });

  it('does not report success when knock listing or blocking fails', async () => {
    mocks.list.mockRejectedValue(new Error('storage down'));
    expect((await GET(getRequest())).status).toBe(500);
    mocks.block.mockRejectedValue(new Error('storage down'));
    const response = await POST(blockRequest(), props());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Unable to block reach sender' });
  });
});
