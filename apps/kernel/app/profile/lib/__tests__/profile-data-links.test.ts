import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLinks } from '../profile-data';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), fetch: vi.fn() }));
vi.mock('@/src/lib/apps/registry-url', () => ({ resolveRegistryAppBaseUrl: mocks.resolve }));
vi.mock('@/src/lib/kernel/session', () => ({ getSessionFromCookies: vi.fn() }));
vi.mock('@/src/lib/chat/connection-check', () => ({ isConnected: vi.fn() }));
vi.mock('@/src/db', () => ({ db: {}, profiles: {}, follows: {}, identityMembers: {}, forestConfig: {} }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('profile links use the registered app endpoint', () => {
  it.each([true, false])('reads both links response shapes (wrapped=%s)', async (wrapped) => {
    mocks.resolve.mockResolvedValue('https://links.example.test');
    vi.stubEnv('LINKS_SERVICE_URL', 'https://stale.test');
    const links = [{ title: 'Studio', url: 'https://studio.example.test' }];
    mocks.fetch.mockResolvedValue(Response.json(wrapped ? { links } : links));
    await expect(getLinks('studio/owner')).resolves.toEqual(links);
    expect(mocks.resolve).toHaveBeenCalledWith('links');
    expect(mocks.fetch).toHaveBeenCalledWith('https://links.example.test/api/pages/studio%2Fowner/links', { cache: 'no-store' });
  });
  it('skips absent registrations without reading a stale env endpoint', async () => {
    mocks.resolve.mockResolvedValue(null);
    await expect(getLinks('studio')).resolves.toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('fails soft when the registry is unavailable', async () => {
    mocks.resolve.mockRejectedValue(new Error('offline'));
    await expect(getLinks('studio')).resolves.toEqual([]);
  });
  it('fails soft on an app error', async () => {
    mocks.resolve.mockResolvedValue('https://links.example.test');
    mocks.fetch.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(getLinks('studio')).resolves.toEqual([]);
  });
});
