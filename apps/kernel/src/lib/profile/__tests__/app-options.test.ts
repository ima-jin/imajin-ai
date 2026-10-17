import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRegistryAppOptions } from '../app-options';

afterEach(() => vi.unstubAllGlobals());

describe('loadRegistryAppOptions', () => {
  it('uses the public listing and excludes static kernel/meta entries', async () => {
    const app = { name: 'registry-only', label: 'Registry Only', source: 'registry' };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ services: [{ name: 'pay', source: 'static' }, app] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadRegistryAppOptions()).toEqual([app]);
    expect(fetchMock).toHaveBeenCalledWith('/registry/api/launcher');
  });

  it('does not invent a static app list when the registry is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(loadRegistryAppOptions()).rejects.toThrow('Failed to load registry apps');
  });
});
