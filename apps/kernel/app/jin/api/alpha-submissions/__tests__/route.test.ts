import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), operator: vi.fn(), list: vi.fn() }));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@/src/lib/notify/operator-approvals', async original => ({
  ...await original<typeof import('@/src/lib/notify/operator-approvals')>(), getOperatorDid: mocks.operator,
}));
vi.mock('@/src/lib/alpha/store', () => ({ listAlphaSubmissions: mocks.list }));
import * as route from '../route';
const req = (query = '') => new NextRequest(`http://localhost/jin/api/alpha-submissions${query}`);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ identity: { id: 'operator' } });
  mocks.operator.mockResolvedValue('operator');
  mocks.list.mockResolvedValue({ submissions: [], hasMore: false });
});
describe('private alpha read', () => {
  it('requires sign-in before reading configuration or submissions', async () => {
    mocks.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await route.GET(req())).status).toBe(401);
    expect(mocks.operator).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'other' },
    { id: 'agent', actingFor: 'operator' },
    { id: 'operator', actingFor: 'other' },
    { id: 'operator', actingAs: 'org', actingAsRole: 'owner' },
    { id: 'other', actingAs: 'operator', actingAsRole: 'admin' },
  ])('returns 403 without leaking submissions for %j', async identity => {
    mocks.auth.mockResolvedValue({ identity });
    expect((await route.GET(req())).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('fails closed without a configured operator', async () => {
    mocks.operator.mockResolvedValue(null);
    expect((await route.GET(req())).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each(['tester', 'integrator', 'partner', 'demo'])('reads %s for the personal operator with no caching', async intent => {
    const response = await route.GET(req(`?intent=${intent}&offset=50`));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.list).toHaveBeenCalledWith(intent, 50);
  });
  it('lists all by default and has no mutation methods', async () => {
    expect(await (await route.GET(req())).json()).toEqual({ submissions: [], hasMore: false });
    expect(mocks.list).toHaveBeenCalledWith(undefined, 0);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(route).not.toHaveProperty(method);
  });
  it.each(['?intent=unknown', '?intent=', '?offset=-1', '?offset=NaN', '?offset=1.5', '?offset=1e2', '?offset=1000000000'])(
    'rejects invalid filter/pagination %s', async query => {
      expect((await route.GET(req(query))).status).toBe(400);
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );
  it('returns a generic unavailable response, not a database exception', async () => {
    mocks.list.mockRejectedValue(new Error('private contact data'));
    const response = await route.GET(req());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private contact data');
  });
});
