import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  where: vi.fn(),
  auth: vi.fn(),
}));
vi.mock('@/src/db', () => ({
  registryApps: { status: 'status', visibility: 'visibility', ownerDid: 'ownerDid' },
  db: { select: () => ({ from: () => ({ where: h.where }) }) },
}));
vi.mock('drizzle-orm', () => ({
  eq: (...eq: unknown[]) => ({ eq }),
  and: (...and: unknown[]) => ({ and }),
  desc: (...desc: unknown[]) => ({ desc }),
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: h.auth,
  resolveActingDid: (identity: { id: string; actingAs?: string }) => identity.actingAs ?? identity.id,
}));
vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: unknown) => handler,
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ identity: { id: 'person', actingAs: 'business' } });
  h.where.mockReturnValue({ orderBy: () => ({ limit: () => ({ offset: async () => [] }) }) });
});
describe('registry list discovery boundary', () => {
  it('filters active public rows in SQL before applying pagination, without requiring a session', async () => {
    const response = await GET(new NextRequest('https://node.test/api/registry/apps'));
    expect(response.status).toBe(200);
    expect(h.where).toHaveBeenCalledWith({ and: [{ eq: ['status', 'active'] }, { eq: ['visibility', 'public'] }] });
    expect(h.auth).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('lets an authenticated owner manage all their own rows, including hidden and internal apps', async () => {
    expect((await GET(new NextRequest('https://node.test/api/registry/apps?owner=me'))).status).toBe(200);
    expect(h.where).toHaveBeenCalledWith({ and: [{ eq: ['ownerDid', 'business'] }] });
  });
  it('does not allow anonymous owner management', async () => {
    h.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await GET(new NextRequest('https://node.test/api/registry/apps?owner=me'))).status).toBe(401);
    expect(h.where).not.toHaveBeenCalled();
  });
});
