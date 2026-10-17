import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ where: vi.fn(), requireAdmin: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: vi.fn() }));
vi.mock('@imajin/auth', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@imajin/logger', () => ({
  withLogger: (_name: string, handler: (...args: unknown[]) => unknown) =>
    (request: unknown) => handler(request, { log: { info: vi.fn() } }),
}));
vi.mock('@/src/db', () => ({
  registryApps: { slug: 'slug', name: 'name', entryUrl: 'entryUrl', status: 'status' },
  db: { select: () => ({ from: () => ({ where: mocks.where }) }) },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.requireAdmin.mockResolvedValue({ did: 'did:admin' });
  mocks.where.mockResolvedValue([
    { slug: 'new-app', name: 'New App', entryUrl: 'https://app.test/new' },
    { slug: 'links', name: 'Links', entryUrl: '/links' },
    { slug: null, name: 'No slug', entryUrl: 'https://not.test' },
  ]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('admin registry service health', () => {
  it('probes absolute registered app endpoints and skips relative paths without a separate origin', async () => {
    const { GET } = await import('../route');
    const response = await GET(new NextRequest('https://node.test/api/admin/services/health'));
    const body = await response.json();
    expect(body.services.filter((service: { group: string }) => service.group === 'userspace'))
      .toMatchObject([{ name: 'new-app', label: 'New App' }]);
    expect(fetch).toHaveBeenCalledWith('https://app.test/new/api/health', expect.any(Object));
  });

  it('supports an explicit extracted-app endpoint instead of a deleted port default', async () => {
    vi.stubEnv('LINKS_URL', 'http://localhost:9555');
    const { GET } = await import('../route');
    await GET(new NextRequest('https://node.test/api/admin/services/health'));
    expect(fetch).toHaveBeenCalledWith('http://localhost:9555/api/health', expect.any(Object));
  });
});
