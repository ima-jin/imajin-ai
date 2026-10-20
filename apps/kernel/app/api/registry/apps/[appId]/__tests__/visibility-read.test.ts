import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  auth: vi.fn(),
  ownerDids: vi.fn(),
}));
vi.mock('@/src/db', () => ({
  registryApps: { id: 'id', visibility: 'visibility' },
  db: { select: () => ({ from: () => ({ where: async () => h.rows }) }) },
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: h.auth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@/src/lib/kernel/app-visibility', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/src/lib/kernel/app-visibility')>(),
  resolveAppOwnerDids: h.ownerDids,
}));
import { GET } from '../route';

const request = new NextRequest('https://node.test/api/registry/apps/app');
const context = { params: Promise.resolve({ appId: 'app' }) };
beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [{ id: 'app', ownerDid: 'owner', visibility: 'private' }];
  h.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
  h.ownerDids.mockResolvedValue(new Set(['person']));
});
describe('registry app detail visibility', () => {
  it('permits authenticated direct-link private anyone detail without directory membership', async () => {
    h.rows[0].signInAudience = 'anyone';
    expect((await GET(request, context)).status).toBe(404);
    h.auth.mockResolvedValue({ identity: { id: 'person' } });
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('signInAudience', 'anyone');
    expect(h.ownerDids).not.toHaveBeenCalled();
  });
  it.each(['public', 'unlisted'])('allows direct anonymous %s detail without an auth requirement', async (visibility) => {
    h.rows[0].visibility = visibility;
    expect((await GET(request, context)).status).toBe(200);
    expect(h.auth).not.toHaveBeenCalled();
  });
  it('conceals private apps from anonymous people and non-members', async () => {
    expect((await GET(request, context)).status).toBe(404);
    h.auth.mockResolvedValue({ identity: { id: 'person' } });
    expect((await GET(request, context)).status).toBe(404);
  });
  it('returns private details to a current owner/member with uncached responses', async () => {
    h.auth.mockResolvedValue({ identity: { id: 'person' } });
    h.ownerDids.mockResolvedValue(new Set(['person', 'owner']));
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('allows only the owner to read internal management details, never a member tile', async () => {
    h.rows[0].visibility = 'internal';
    h.auth.mockResolvedValue({ identity: { id: 'person' } });
    expect((await GET(request, context)).status).toBe(404);
    h.auth.mockResolvedValue({ identity: { id: 'owner' } });
    expect((await GET(request, context)).status).toBe(200);
  });
  it('does not reveal a nonexistent registry row', async () => {
    h.rows = [];
    expect((await GET(request, context)).status).toBe(404);
  });
});
