// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLauncherServices, type LauncherService } from '../src/launcher-services';

const request = vi.fn();
const kernel: LauncherService = {
  name: 'pay', label: 'Wallet', icon: 'wallet', description: 'Wallet',
  visibility: 'authenticated', category: 'kernel', url: '/pay', source: 'static',
};
const app: LauncherService = {
  name: 'coffee', label: 'Coffee', icon: 'coffee', description: 'Tips',
  visibility: 'public', category: 'core', url: 'https://node.test/coffee', source: 'registry',
};
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  vi.stubGlobal('fetch', request);
  request.mockReset();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('loadLauncherServices', () => {
  it('uses the public launcher only for anonymous viewers', async () => {
    request.mockResolvedValue(response({ services: [kernel, app] }));
    expect(await loadLauncherServices('/registry', '/auth', false)).toEqual([kernel, app]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/registry/api/launcher');
  });

  it('uses only the person’s apps and retains static kernel/project entries', async () => {
    const spoof = { ...app, name: 'not-kernel', category: 'core', source: 'static' };
    request.mockResolvedValueOnce(response({ services: [kernel, app, spoof] }));
    request.mockResolvedValueOnce(response({ apps: [{ slug: 'coffee', name: 'My Coffee', icon: null }] }));
    const entries = await loadLauncherServices('/registry', '/auth', true);
    expect(entries.map((entry) => entry.name)).toEqual(['pay', 'coffee']);
    expect(entries[1]).toMatchObject({ label: 'My Coffee', description: 'Tips', icon: 'coffee', url: app.url });
    expect(request).toHaveBeenLastCalledWith('/auth/api/apps?placement=launcher', {
      credentials: 'include', headers: {}, cache: 'no-store',
    });
  });

  it('an explicitly empty app list is empty even with public apps', async () => {
    request.mockResolvedValueOnce(response({ services: [kernel, app] }));
    request.mockResolvedValueOnce(response({ apps: [] }));
    expect(await loadLauncherServices('/registry', '/auth', true)).toEqual([kernel]);
  });

  it('includes scope-gated apps not listed in public discovery', async () => {
    request.mockResolvedValueOnce(response({ services: [kernel] }));
    request.mockResolvedValueOnce(response({ apps: [
      { slug: 'org-only', name: 'Org app', icon: null, entryUrl: '/org-only' },
      { slug: 'new-app', name: 'New app', icon: 'new', entryUrl: null },
    ] }));
    const entries = await loadLauncherServices('/registry', '/auth', true);
    expect(entries[1]).toMatchObject({ name: 'org-only', label: 'Org app', icon: '🧩', category: 'core' });
    expect(entries[2].url).toBe(`${location.origin}/new-app`);
  });

  it('forwards acting-as to the authenticated endpoint', async () => {
    localStorage.setItem('imajin:acting-as', 'did:imajin:group');
    request.mockResolvedValueOnce(response({ services: [kernel, app] }));
    request.mockResolvedValueOnce(response({ apps: [] }));
    await loadLauncherServices('/registry', '/auth', true);
    expect(request).toHaveBeenLastCalledWith('/auth/api/apps?placement=launcher', expect.objectContaining({
      headers: { 'X-Acting-As': 'did:imajin:group' }, credentials: 'include',
    }));
  });

  it.each(['http', 'network', 'malformed'])('fails closed on same-origin %s failure', async (failure) => {
    request.mockResolvedValueOnce(response({ services: [kernel, app] }));
    if (failure === 'network') request.mockRejectedValueOnce(new Error('unavailable'));
    else request.mockResolvedValueOnce(response({}, failure !== 'http'));
    expect(await loadLauncherServices('/registry', '/auth', true)).toEqual([kernel]);
  });

  it.each(['http', 'network'])('degrades to public discovery for standalone cross-origin %s failures', async (failure) => {
    request.mockResolvedValueOnce(response({ services: [kernel, app] }));
    if (failure === 'network') request.mockRejectedValueOnce(new TypeError('CORS'));
    else request.mockResolvedValueOnce(response({}, false));
    expect(await loadLauncherServices('https://node.test/registry', 'https://node.test/auth', true)).toEqual([kernel, app]);
    expect(request).toHaveBeenLastCalledWith('https://node.test/auth/api/apps?placement=launcher', expect.objectContaining({
      credentials: 'include',
    }));
  });

  it('keeps a successful cross-origin empty personal list empty', async () => {
    request.mockResolvedValueOnce(response({ services: [kernel, app] }));
    request.mockResolvedValueOnce(response({ apps: [] }));
    expect(await loadLauncherServices('https://node.test/registry', 'https://node.test/auth', true)).toEqual([kernel]);
  });

  it.each(['http', 'network', 'missing'])('handles unavailable public %s lists without blocking personal apps', async (failure) => {
    if (failure === 'network') request.mockRejectedValueOnce(new TypeError('offline'));
    else request.mockResolvedValueOnce(response({}, failure !== 'http'));
    request.mockResolvedValueOnce(response({ apps: [{ slug: 'new-app', name: 'New app', icon: null }] }));
    const entries = await loadLauncherServices('/registry', '/auth', true);
    expect(entries.map((entry) => entry.name)).toEqual(['new-app']);
  });
});
