import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  directory: vi.fn(),
  person: vi.fn(),
  group: vi.fn(),
  canManage: vi.fn(),
  scope: 'actor' as string | null,
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: h.requireAuth,
  resolveActingDid: (identity: { id: string; actingAs?: string }) => identity.actingAs ?? identity.id,
}));
vi.mock('@/src/db', () => {
  const limit = async () => h.scope ? [{ scope: h.scope }] : [];
  const where = () => ({ limit });
  const from = () => ({ where });
  return {
    identities: { scope: 'scope', id: 'id' },
    db: { select: () => ({ from }) },
  };
});
vi.mock('@/src/lib/kernel/app-nav', () => ({ resolveAppDirectoryForIdentity: h.directory }));
vi.mock('@/src/lib/kernel/app-membership', () => ({
  setPersonAppMembership: h.person, setGroupAppMembership: h.group, canManageGroupApps: h.canManage,
}));
import { DELETE, PUT } from '../route';
import { GET } from '../../directory/route';

const context = { params: Promise.resolve({ slug: 'coffee' }) };
function request(method = 'PUT', query = '', body?: unknown) {
  return new NextRequest(`https://example.com/auth/api/apps/coffee${query}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.requireAuth.mockResolvedValue({ identity: { id: 'person' } });
  h.directory.mockResolvedValue([{ slug: 'coffee', available: true, added: false, authorized: true }]);
  h.canManage.mockResolvedValue(false);
  h.scope = 'actor';
});

describe('app directory API', () => {
  it('requires authentication for directory reads and writes', async () => {
    h.requireAuth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await GET(request('GET')))?.status).toBe(401);
    expect((await PUT(request(), context))?.status).toBe(401);
    expect(h.directory).not.toHaveBeenCalled();
  });
  it('returns a self-scoped uncached directory', async () => {
    const response = await GET(request('GET'));
    expect(h.directory).toHaveBeenCalledWith('person');
    expect(await response?.json()).toEqual({ apps: [{ slug: 'coffee', available: true, added: false, authorized: true }] });
    expect(response?.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it.each(['for', 'target', 'did', 'targetDid'])('rejects query %s spoofing on reads and writes', async (key) => {
    expect((await GET(request('GET', `?${key}=other`)))?.status).toBe(403);
    expect((await PUT(request('PUT', `?${key}=other`), context))?.status).toBe(403);
    expect(h.person).not.toHaveBeenCalled();
  });
  it.each(['for', 'target', 'did', 'targetDid'])('rejects body %s spoofing', async (key) => {
    expect((await PUT(request('PUT', '', { [key]: 'other' }), context))?.status).toBe(403);
  });
  it('allows an exact own target but never trusts it to choose the identity', async () => {
    expect((await PUT(request('PUT', '?for=person', { target: 'person' }), context))?.status).toBe(200);
    expect(h.person).toHaveBeenCalledWith('person', 'coffee', true);
  });
  it.each([null, [], 'string'])('rejects malformed body %s', async (body) => {
    expect((await PUT(request('PUT', '', body), context))?.status).toBe(400);
  });
  it('rejects invalid JSON', async () => {
    const req = new NextRequest('https://example.com/auth/api/apps/coffee', { method: 'PUT', body: '{' });
    expect((await PUT(req, context))?.status).toBe(400);
  });
  it('does not mutate an unknown identity or app', async () => {
    h.scope = null;
    expect((await PUT(request(), context))?.status).toBe(404);
    h.scope = 'actor';
    h.directory.mockResolvedValue([]);
    expect((await PUT(request(), context))?.status).toBe(404);
  });
  it('refuses a different actor identity even with acting-as', async () => {
    h.requireAuth.mockResolvedValue({ identity: { id: 'person', actingAs: 'other-actor' } });
    expect((await PUT(request(), context))?.status).toBe(403);
    expect(h.person).not.toHaveBeenCalled();
  });
  it('requires owner/admin for effective group writes', async () => {
    h.scope = 'business';
    h.requireAuth.mockResolvedValue({ identity: { id: 'person', actingAs: 'group' } });
    expect((await PUT(request(), context))?.status).toBe(403);
    expect(h.canManage).toHaveBeenCalledWith('group', 'person');
    h.canManage.mockResolvedValue(true);
    expect((await PUT(request(), context))?.status).toBe(200);
    expect(h.group).toHaveBeenCalledWith('group', 'coffee', true);
  });
  it('gates additions by scope but permits removal of unavailable membership', async () => {
    h.directory.mockResolvedValue([{ slug: 'coffee', available: false, added: true }]);
    expect((await PUT(request(), context))?.status).toBe(403);
    expect((await DELETE(request('DELETE'), context))?.status).toBe(200);
    expect(h.person).toHaveBeenCalledWith('person', 'coffee', false);
  });
  it('returns refreshed authorization state after removing membership, without revocation', async () => {
    h.directory.mockResolvedValueOnce([{ slug: 'coffee', available: true, added: true, authorized: true }])
      .mockResolvedValueOnce([{ slug: 'coffee', available: true, added: false, authorized: true }]);
    const response = await DELETE(request('DELETE'), context);
    expect(await response?.json()).toEqual({ apps: [{ slug: 'coffee', available: true, added: false, authorized: true }] });
    expect(h.person).toHaveBeenCalledWith('person', 'coffee', false);
    expect(h.group).not.toHaveBeenCalled();
  });
});
