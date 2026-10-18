// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JinNavEntry } from '../../../../../packages/ui/src/jin-nav-entry';
import { NavBar } from '../../../../../packages/ui/src/nav-bar';

vi.mock('../../../../../packages/ui/src/app-launcher', () => ({ AppLauncher: () => null }));
vi.mock('../../../../../packages/ui/src/notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('../../../../../packages/ui/src/use-identities', () => ({
  useIdentities: () => ({ identities: [], activeIdentity: null, activeConfig: null, setActiveIdentity: vi.fn() }),
}));

const fetchMock = vi.fn();
const href = 'https://node.example/jin';
const identityDid = 'did:imajin:operator';
function inbox(statuses: string[] = [], canAccess = true) {
  return { ok: true, json: async () => ({ canAccess, approvals: statuses.map(status => ({ status })) }) };
}
function entry() {
  return render(<JinNavEntry href={href} identityDid={identityDid} />);
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue(inbox());
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('persistent Jin nav entry', () => {
  it('shows an empty operator console without a zero badge', async () => {
    entry();
    const link = await screen.findByRole('link', { name: '/jin — operator console' });
    expect(link.getAttribute('href')).toBe(href);
    expect(link.textContent).toBe('/jin');
    expect(fetchMock).toHaveBeenCalledWith(`${href}/api/operator-approvals?view=acting`, expect.objectContaining({
      credentials: 'include', cache: 'no-store', headers: {},
    }));
  });

  it('counts pending only and caps the visual badge, not the accessible count', async () => {
    fetchMock.mockResolvedValue(inbox([...Array<string>(101).fill('pending'), 'approved', 'denied', 'applied', 'expired']));
    entry();
    const link = await screen.findByRole('link', { name: '/jin — 101 pending Inbox approvals' });
    expect(link.textContent).toBe('/jin99+');
  });

  it('does not request an Inbox when signed out', () => {
    render(<JinNavEntry href={href} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])('hides the link on HTTP %s', async status => {
    fetchMock.mockResolvedValue({ ok: false, status });
    entry();
    await act(async () => {});
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('hides principals with no access and fails closed on an old API without canAccess', async () => {
    fetchMock.mockResolvedValueOnce(inbox([], false)).mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    entry();
    await act(async () => {});
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.focus(window);
    await act(async () => {});
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('handles a network failure without retaining stale attention', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    entry();
    await screen.findByRole('link');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull());
    expect(errorLog).toHaveBeenCalled();
  });

  it.each(['focus', 'jin:operator-approvals-refresh'])('refreshes on %s', async event => {
    entry();
    await screen.findByRole('link');
    fetchMock.mockResolvedValue(inbox(['pending', 'pending']));
    fireEvent(window, new Event(event));
    await screen.findByRole('link', { name: '/jin — 2 pending Inbox approvals' });
  });

  it('polls and removes timers and listeners on unmount', async () => {
    vi.useFakeTimers();
    const view = entry();
    await act(async () => {});
    fetchMock.mockResolvedValue(inbox(['pending']));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole('link').textContent).toBe('/jin1');
    const signal = fetchMock.mock.lastCall?.[1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    const count = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      fireEvent.focus(window);
      fireEvent(window, new Event('imajin:acting-as-changed'));
      fireEvent(window, new Event('jin:operator-approvals-refresh'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it('clears personal attention on scope switch, sends act-as and ignores stale responses', async () => {
    entry();
    await screen.findByRole('link');
    let resolveOld!: (value: ReturnType<typeof inbox>) => void;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    fireEvent.focus(window);
    localStorage.setItem('imajin:acting-as', 'did:imajin:org');
    fetchMock.mockResolvedValueOnce(inbox(['pending']));
    fireEvent(window, new Event('imajin:acting-as-changed'));
    expect(screen.queryByRole('link')).toBeNull();
    await screen.findByRole('link', { name: '/jin — 1 pending Inbox approvals' });
    expect(fetchMock.mock.lastCall?.[1].headers).toEqual({ 'X-Acting-As': 'did:imajin:org' });
    await act(async () => { resolveOld(inbox(Array<string>(10).fill('pending'))); });
    expect(screen.getByRole('link').textContent).toBe('/jin1');
  });

  it('ignores a rejected stale request and refreshes after session changes', async () => {
    entry();
    await screen.findByRole('link');
    let rejectOld!: (reason: Error) => void;
    fetchMock.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }));
    fireEvent.focus(window);
    fetchMock.mockResolvedValueOnce(inbox(['pending']));
    fireEvent(window, new Event('imajin:session-changed'));
    await screen.findByRole('link', { name: '/jin — 1 pending Inbox approvals' });
    await act(async () => { rejectOld(new Error('aborted')); });
    expect(screen.getByRole('link').textContent).toBe('/jin1');
  });

  it('removes the link when its identity logs out', async () => {
    const view = entry();
    await screen.findByRole('link');
    view.rerender(<JinNavEntry href={href} identityDid={null} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('is a top-level shared header item outside desktop-only and mobile-menu containers', async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes('operator-approvals') ? inbox(['pending']) : { ok: false });
    render(<NavBar identity={{ isLoggedIn: true, did: identityDid, handle: 'operator' }}
      servicePrefix="https://node.example/" />);
    const link = await screen.findByRole('link', { name: '/jin — 1 pending Inbox approvals' });
    expect(link.getAttribute('href')).toBe(href);
    expect(link.parentElement?.parentElement?.tagName).toBe('NAV');
    expect(link.parentElement?.className).not.toContain('hidden');
    expect(link.closest('.hidden')).toBeNull();
  });
});
