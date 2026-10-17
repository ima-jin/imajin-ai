// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppLauncher } from '../../../../../packages/ui/src/app-launcher';

const mocks = vi.hoisted(() => ({ activeIdentity: null as string | null, switchIdentity: vi.fn() }));
vi.mock('../../../../../packages/ui/src/use-identities', () => ({
  useIdentities: () => ({
    identities: [{ groupDid: 'group', scope: 'community', name: 'Group' }],
    activeIdentity: mocks.activeIdentity, setActiveIdentity: mocks.switchIdentity,
  }),
}));
const request = vi.fn();
const staticEntry = (name: string, label: string, visibility = 'authenticated') => ({
  name, label, icon: name, description: label, visibility, category: 'kernel', url: `/${name}`, source: 'static',
});
const publicServices = [
  staticEntry('kernel', 'Home', 'public'), staticEntry('pay', 'Wallet'), staticEntry('media', 'Media'),
  staticEntry('usage', 'Usage', 'internal'),
  staticEntry('calendar', 'Calendar', 'internal'), staticEntry('google', 'Google Workspace', 'internal'),
  { ...staticEntry('coffee', 'Coffee', 'public'), category: 'creator', source: 'registry' },
  { ...staticEntry('not-added', 'Not added', 'public'), category: 'core', source: 'registry' },
];
let apps: Array<{ slug: string; name: string; icon: string | null }> = [];
const props = { registryUrl: '/registry', authUrl: '/auth', tier: 'hard' as const, inline: true };

beforeEach(() => {
  mocks.activeIdentity = null;
  mocks.switchIdentity.mockReset();
  apps = [{ slug: 'coffee', name: 'Coffee', icon: null }];
  request.mockReset().mockImplementation(async (url: string) => ({
    ok: true, json: async () => url.includes('/api/launcher') ? { services: publicServices } : { apps },
  }));
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AppLauncher registry navigation', () => {
  it.each(['grid', 'list'] as const)('shows only added apps and kernel pages in %s mode without Creator Tools', async (variant) => {
    render(<AppLauncher {...props} variant={variant} />);
    await screen.findByText('Coffee');
    expect(screen.queryByText('Not added')).toBeNull();
    expect(screen.queryByText('Creator Tools')).toBeNull();
    expect(screen.queryByText('Usage')).toBeNull();
    expect(screen.queryByText('Calendar')).toBeNull();
    expect(screen.queryByText('Google Workspace')).toBeNull();
    expect(screen.getByText('Wallet').closest('a')?.getAttribute('href')).toBe('/pay');
    expect(screen.getByText('Media').closest('a')?.getAttribute('href')).toBe('/media');
    expect(screen.getByText('See all apps →').getAttribute('href')).toBe('/kernel');
    expect(screen.getByRole('link', { name: 'Add app' }).getAttribute('href')).toBe('/auth/app-directory');
    expect(request.mock.calls.some(([url]) => String(url).includes('/api/specs'))).toBe(false);
  });

  it.each(['', '/', 'https://node.test/'])('keeps home destination %j intact', async (url) => {
    const services = publicServices.map((entry) => entry.name === 'kernel' ? { ...entry, url } : entry);
    request.mockImplementation(async (input: string) => ({
      ok: true, json: async () => input.includes('/api/launcher')
        ? { services }
        : { apps },
    }));
    render(<AppLauncher {...props} />);
    await screen.findByText('Coffee');
    expect(screen.getByText('See all apps →').getAttribute('href')).toBe(url || '/');
  });

  it('anonymous viewers use only public discovery, without authenticated kernel pages', async () => {
    render(<AppLauncher {...props} tier="anonymous" />);
    await screen.findByText('Not added');
    expect(screen.queryByText('Wallet')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add app' })).toBeNull();
    expect(request.mock.calls.some(([url]) => String(url).includes('/api/apps'))).toBe(false);
  });

  it('retains group Wallet and Media only when enabled, without hiding other kernel links', async () => {
    mocks.activeIdentity = 'group';
    const { rerender } = render(<AppLauncher {...props} enabledServices={['pay', 'media']} />);
    await screen.findByText('Wallet');
    expect(screen.getByText('Media')).toBeDefined();
    expect(screen.getByText('Home')).toBeDefined();
    rerender(<AppLauncher {...props} enabledServices={[]} />);
    expect(screen.queryByText('Wallet')).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
    expect(screen.getByText('Home')).toBeDefined();
  });

  it.each(['imajin:session-changed', 'imajin:acting-as-changed', 'imajin:apps-changed'])('refetches and clears previous apps on %s', async (event) => {
    render(<AppLauncher {...props} />);
    await screen.findByText('Coffee');
    apps = [];
    act(() => { globalThis.dispatchEvent(new Event(event)); });
    await waitFor(() => expect(screen.queryByText('Coffee')).toBeNull());
    expect(request.mock.calls.filter(([url]) => String(url).includes('/api/apps')).length).toBeGreaterThan(1);
  });

  it('refetches when the session DID changes and ignores an old in-flight response', async () => {
    let resolveOld: (value: unknown) => void = () => undefined;
    request.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { rerender } = render(<AppLauncher {...props} identityDid="old" />);
    apps = [];
    rerender(<AppLauncher {...props} identityDid="new" />);
    await screen.findByText('Wallet');
    await act(async () => {
      resolveOld({ ok: true, json: async () => ({ services: publicServices }) });
    });
    expect(screen.queryByText('Coffee')).toBeNull();
  });

  it('derives auth on the registry node for consumers without authUrl', async () => {
    render(<AppLauncher registryUrl="https://node.test/registry" tier="hard" inline />);
    await screen.findByText('Coffee');
    expect(request).toHaveBeenCalledWith('https://node.test/auth/api/apps?placement=launcher', expect.anything());
    expect(screen.getByRole('link', { name: 'Add app' }).getAttribute('href')).toBe('https://node.test/auth/app-directory');
  });

  it('opens/closes the flyout and switches identities', async () => {
    render(<AppLauncher {...props} inline={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Launcher/ }));
    await screen.findByText('Coffee');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Coffee')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Launcher/ }));
    fireEvent.click(screen.getByText('Group'));
    expect(mocks.switchIdentity).toHaveBeenCalledWith('group');
    expect(screen.queryByText('Coffee')).toBeNull();
  });
});
