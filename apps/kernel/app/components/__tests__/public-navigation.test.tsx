// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavBar } from '../../../../../packages/ui/src/nav-bar';
import { NavBarWithUnread } from '../NavBarWithUnread';
import { NavBar as KernelNavBar } from '../NavBar';

const mocks = vi.hoisted(() => ({
  identities: vi.fn(),
  launcher: vi.fn(),
}));
vi.mock('../../../../../packages/ui/src/app-launcher', () => ({
  AppLauncher: (props: object) => { mocks.launcher(props); return <button type="button">Apps</button>; },
}));
vi.mock('../../../../../packages/ui/src/notification-bell', () => ({
  NotificationBell: () => <button type="button">Notifications</button>,
}));
vi.mock('../../../../../packages/ui/src/use-identities', () => ({ useIdentities: mocks.identities }));
vi.mock('@/src/contexts/UnreadCountContext', () => ({ useUnreadCount: () => ({ total: 7 }) }));

const fetchMock = vi.fn();
const base = 'https://node.example';
const person = { isLoggedIn: true, did: 'did:imajin:person', handle: 'personal', tier: 'established' };
const org = { groupDid: 'did:imajin:org', name: 'Example Business', handle: 'business', scope: 'org' };
const targets = [
  ['Product', '/#product'],
  ['How it works', '/how-it-works'],
  ['Compare', '/compare'],
  ['Developers', '/docs'],
] as const;

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_NOTIFY_URL', `${base}/notify`);
  mocks.launcher.mockClear();
  mocks.identities.mockReturnValue({ identities: [], activeIdentity: null, activeConfig: null, setActiveIdentity: vi.fn() });
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url.includes('operator-approvals')) return { ok: true, json: async () => ({ canAccess: true, pending: 2 }) };
    if (url.includes('conversations/unread')) return { ok: true, json: async () => ({ total: 7 }) };
    return { ok: false, status: 401 };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function publicLinks(container: HTMLElement, origin = base) {
  const view = within(container);
  for (const [name, path] of targets) expect(view.getByRole('link', { name }).getAttribute('href')).toBe(`${origin}${path}`);
  const company = view.getByText('Company').closest('details')!;
  expect(company.open).toBe(false);
  fireEvent.click(view.getByText('Company'));
  // jsdom does not emulate the native summary toggle; verify the disclosed targets too.
  expect(within(company).getByText('Why we built it').getAttribute('href')).toBe(`${origin}/project`);
  expect(within(company).getByText('Whitepaper').getAttribute('href')).toBe(`${origin}/whitepaper`);
}

describe('shared main navigation acceptance', () => {
  it('shows exactly the five top-level items signed out, without community apps or operator controls', async () => {
    const login = vi.fn();
    render(<NavBar servicePrefix={`${base}/`} identity={{ isLoggedIn: false, onLogin: login }} />);
    await act(async () => {});
    const list = screen.getByRole('link', { name: 'Product' }).closest('ul')!;
    expect(Array.from(list.children).map(item => item.firstElementChild?.textContent?.split('Why')[0])).toEqual([
      'Product', 'How it works', 'Compare', 'Developers', 'Company',
    ]);
    publicLinks(list);
    expect(mocks.launcher).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Notifications' })).toBeNull();
    expect(screen.queryByTitle('Messages')).toBeNull();
    expect(screen.queryByText('/jin')).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url).every(url => url.endsWith('/api/session'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    expect(login).toHaveBeenCalledOnce();
  });

  it('opens and closes the same public IA in the mobile menu without an app launcher', async () => {
    render(<NavBar servicePrefix={`${base}/`} identity={{ isLoggedIn: false }} />);
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getAllByText('Product').at(-1)!.closest('ul')!;
    publicLinks(menu);
    expect(mocks.launcher).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(screen.getAllByText('Product')).toHaveLength(1);
    await act(async () => {});
  });

  it.each(['personal', 'org'])('keeps apps, /jin, unread, and effective identity labels in %s context', async context => {
    if (context === 'org') {
      localStorage.setItem('imajin:acting-as', org.groupDid);
      mocks.identities.mockReturnValue({ identities: [org], activeIdentity: org.groupDid, activeConfig: { enabledServices: ['chat'] }, setActiveIdentity: vi.fn() });
    }
    render(<NavBar servicePrefix={`${base}/`} identity={person} unreadMessages={7} />);
    expect(await screen.findByRole('link', { name: '/jin — 2 pending Inbox approvals' })).toBeDefined();
    expect(screen.queryByText('Product')).toBeNull();
    expect(screen.queryByText('Company')).toBeNull();
    expect(screen.getByRole('button', { name: 'Apps' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeDefined();
    expect(screen.getByTitle('Messages').textContent).toContain('7');
    expect(screen.getByText(context === 'org' ? org.name : '@personal')).toBeDefined();
    if (context === 'org') {
      expect(screen.queryByText('@personal')).toBeNull();
      expect(screen.getByText('acting as')).toBeDefined();
    }
    expect(fetchMock).toHaveBeenCalledWith(`${base}/pay/api/balance/${encodeURIComponent(context === 'org' ? org.groupDid : person.did)}`, expect.anything());
    expect(fetchMock).toHaveBeenCalledWith(`${base}/jin/api/operator-approvals?view=acting&count=true`, expect.objectContaining({
      headers: context === 'org' ? { 'X-Acting-As': org.groupDid } : {},
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    expect(screen.getAllByRole('button', { name: 'Apps' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: /Messages/ }).textContent).toContain('7');
    expect(screen.queryByText('Product')).toBeNull();
    expect(mocks.launcher).toHaveBeenCalledWith(expect.objectContaining({ tier: 'hard' }));
    expect(mocks.launcher).toHaveBeenLastCalledWith(expect.objectContaining({ inline: true, authUrl: `${base}/auth` }));
  });

  it('does not expose hard-identity shortcuts to a soft session', async () => {
    render(<NavBar servicePrefix={`${base}/`} identity={{ ...person, tier: 'soft' }} />);
    await act(async () => {});
    expect(screen.queryByTitle('Messages')).toBeNull();
    expect(screen.queryByTitle('Connections')).toBeNull();
    expect(screen.getByRole('button', { name: 'Logout' })).toBeDefined();
    expect(mocks.launcher).toHaveBeenCalledWith(expect.objectContaining({ tier: 'soft' }));
    expect(screen.queryByText('Product')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    expect(mocks.launcher).toHaveBeenLastCalledWith(expect.objectContaining({ inline: true, authUrl: undefined }));
  });

  it.each([401, 503, 'network'])('keeps public navigation and no privileged controls when session lookup fails: %s', async status => {
    if (status === 'network') fetchMock.mockRejectedValue(new Error('offline'));
    else fetchMock.mockResolvedValue({ ok: false, status });
    render(<NavBar servicePrefix={`${base}/`} />);
    await act(async () => {});
    expect(screen.getByRole('link', { name: 'Product' })).toBeDefined();
    expect(mocks.launcher).not.toHaveBeenCalled();
    expect(screen.queryByText('/jin')).toBeNull();
  });

  it('switches from public IA to app controls and back as the session changes', async () => {
    render(<NavBar servicePrefix={`${base}/`} />);
    await screen.findByRole('button', { name: 'Login' });
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/api/session')
      ? { ok: true, json: async () => person }
      : { ok: false, status: 403 });
    fireEvent(window, new Event('imajin:session-changed'));
    await screen.findByRole('button', { name: 'Apps' });
    expect(screen.queryByText('Product')).toBeNull();
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    fireEvent(window, new Event('imajin:session-changed'));
    await screen.findByRole('link', { name: 'Product' });
    expect(screen.queryByRole('button', { name: 'Apps' })).toBeNull();
    expect(screen.queryByText('@personal')).toBeNull();
  });

  it.each(['https://dev.example/', 'https://www.example'])('keeps public links on the configured home origin %s', async www => {
    render(<NavBar serviceUrls={{ www }} identity={{ isLoggedIn: false }} />);
    publicLinks(screen.getByRole('link', { name: 'Product' }).closest('ul')!, www.endsWith('/') ? www.slice(0, -1) : www);
    await act(async () => {});
  });

  it.each([KernelNavBar, NavBarWithUnread])('wires the kernel header wrappers into the shared session-aware nav', async Component => {
    render(<Component />);
    await screen.findByRole('button', { name: 'Login' });
    expect(screen.getByRole('link', { name: 'Product' })).toBeDefined();
    expect(mocks.launcher).not.toHaveBeenCalled();
  });
});
