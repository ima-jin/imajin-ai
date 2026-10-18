import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRegistryAppOptions } from '../app-options';
vi.mock('@imajin/ui/server', () => ({ getActingAsHeaders: () => ({}) }));

afterEach(() => vi.unstubAllGlobals());

describe('loadRegistryAppOptions', () => {
  it('uses the authenticated directory, including member-private apps and excluding unavailable apps', async () => {
    const app = { slug: 'registry-only', name: 'Registry Only', entryUrl: '/registry-only', available: true, visibility: 'private' };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ apps: [{ slug: 'unavailable', available: false }, app] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadRegistryAppOptions('group')).toEqual([expect.objectContaining({
      name: 'registry-only', label: 'Registry Only', source: 'registry',
    })]);
    expect(fetchMock).toHaveBeenCalledWith('/auth/api/apps/directory', {
      credentials: 'include', cache: 'no-store', headers: { 'X-Acting-As': 'group' },
    });
  });

  it('does not invent a static app list when the registry is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(loadRegistryAppOptions()).rejects.toThrow('Failed to load registry apps');
  });
});
