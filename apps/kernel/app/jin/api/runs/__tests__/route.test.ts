import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runLoop } from '@/src/lib/jin/__tests__/runs-fixture';

const { auth, operator, list, history } = vi.hoisted(() => ({
  auth: vi.fn(), operator: vi.fn(), list: vi.fn(), history: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ requireAuth: auth }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://test.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@/src/lib/notify/operator-approvals', async (original) => ({
  ...await original<typeof import('@/src/lib/notify/operator-approvals')>(),
  getOperatorDid: operator,
}));
vi.mock('@/src/lib/loops/query', () => ({ listLoopsPage: list, getLoopWithHistory: history }));

import { GET as getList, OPTIONS as listOptions } from '../route';
import { GET as getDetail, OPTIONS as detailOptions } from '../[loopId]/route';

const DID = 'did:imajin:operator';
const request = (query = '') => new Request(`https://test.imajin.ai/jin/api/runs${query}`) as Parameters<typeof getList>[0];
const detail = (id = 'loop-1') => getDetail(request(), { params: Promise.resolve({ loopId: id }) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ identity: { id: DID } });
  operator.mockResolvedValue(DID);
  list.mockResolvedValue({ loops: [runLoop()], hasNextPage: false, nextCursor: null });
  history.mockResolvedValue({ loop: runLoop(), events: [] });
});

describe('Runs operator adapters', () => {
  it('shares CORS preflight on both routes', async () => {
    expect((await listOptions(request())).status).toBe(204);
    expect((await detailOptions(request())).status).toBe(204);
  });

  it('rejects unauthenticated requests before either registry read', async () => {
    auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await getList(request())).status).toBe(401);
    expect((await detail()).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'did:imajin:other' },
    { id: 'did:imajin:agent', actingFor: DID },
    { id: DID, actingFor: 'did:imajin:other' },
  ])('hides both projections from nonoperator or delegated identity %j', async (identity) => {
    auth.mockResolvedValue({ identity });
    const response = await getList(request('?since=invalid'));
    expect(await response.json()).toEqual({ isOperator: false, page: null });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await (await detail()).json()).toEqual({ isOperator: false, detail: null });
    expect(list).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it('hides both routes when the node has no operator', async () => {
    operator.mockResolvedValue(null);
    expect(await (await getList(request())).json()).toEqual({ isOperator: false, page: null });
    expect(await (await detail()).json()).toEqual({ isOperator: false, detail: null });
  });

  it('keeps registry cursor opaque while putting loaded blockers first', async () => {
    const blocked = runLoop({ loopId: 'blocked', lastEventType: 'loop.blocked' });
    list.mockResolvedValue({ loops: [runLoop(), blocked], hasNextPage: true, nextCursor: 'opaque' });
    const response = await getList(request());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://test.imajin.ai');
    expect(await response.json()).toEqual({
      isOperator: true, page: { loops: [blocked, runLoop()], hasNextPage: true, nextCursor: 'opaque' },
    });
    expect(list).toHaveBeenCalledWith({ principal: DID, state: null, kind: null, since: null, ancestor: null, cursor: null, limit: 50 });
  });

  it('passes validated filters, lineage and pagination only for the operator principal', async () => {
    await getList(request(`?principal=${DID}&state=blocked&kind=warp.run&since=2026-10-01&ancestor=root&cursor=next&limit=12`));
    expect(list).toHaveBeenCalledWith({ principal: DID, state: 'blocked', kind: 'warp.run', since: '2026-10-01', ancestor: 'root', cursor: 'next', limit: 12 });
  });

  it.each(['?since=nope', '?limit=0', '?limit=201', '?limit=1.5', '?limit=NaN'])('rejects invalid filters %s', async (query) => {
    expect((await getList(request(query))).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects attempts to change principal', async () => {
    expect((await getList(request('?principal=did:imajin:other'))).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it('returns operator-scoped history and rejects empty or unknown IDs', async () => {
    expect(await (await detail()).json()).toEqual({ isOperator: true, detail: { loop: runLoop(), events: [] } });
    expect(history).toHaveBeenCalledWith('loop-1', DID);
    expect((await detail(' ')).status).toBe(400);
    history.mockResolvedValue(null);
    expect((await detail('unknown-or-other-principal')).status).toBe(404);
  });

  it('sanitizes registry failures on both adapters', async () => {
    list.mockRejectedValue(new Error('private database value'));
    history.mockRejectedValue(new Error('private database value'));
    const responses = [await getList(request()), await detail()];
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain('private');
    }
  });
});
