// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RegisteredAppScopesPanel } from '../registered-app-scopes-panel';
import { APPROVALS_REFRESH_EVENT } from '../approval-anchor';

const URL = '/api/apps/service-scopes';
const app = {
  appDid: 'did:imajin:self-registered',
  name: 'Self registered without a slug',
  status: 'active',
  requestedScopes: ['pay:settle', 'notify:send', 'unknown:legacy'],
  approvedServiceScopes: ['identity:read'],
  approvalId: 'appscope_recorded',
  approvedAt: '2026-10-20T14:00:00.000Z',
};

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function page(apps = [app], nextCursor: string | null = null) {
  return response({ apps, nextCursor });
}

function installFetch() {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? response({ status: 'pending', proposalId: 'appscope_subset' }, 201)
    : page());
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function openPicker() {
  const button = await screen.findByRole('button', { name: 'Propose scopes' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

function approvedText() {
  return screen.getByText('Approved service scopes:').textContent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('registered app service scope discovery', () => {
  it('discovers a self-registered app without a slug or knowing its DID', async () => {
    const spy = installFetch();
    render(<RegisteredAppScopesPanel />);
    expect(await screen.findByText(app.name)).toBeDefined();
    await waitFor(() => expect(approvedText()).toBe('Approved service scopes: identity:read'));
    expect(screen.getByText(app.appDid)).toBeDefined();
    expect(screen.getByText('Registry status: active')).toBeDefined();
    expect(screen.getByText('Requested scopes:').textContent).toContain('pay:settle, notify:send, unknown:legacy');
    expect(screen.getByRole('link', { name: app.approvalId }).getAttribute('href')).toBe('#approval-appscope_recorded');
    expect(screen.getByText(/Recorded approval:/).textContent).toContain(app.approvedAt);
    expect(spy.mock.calls).toEqual([[URL, { credentials: 'include' }]]);
  });

  it('proposes one selected scope and links to the existing signed card, never claiming remaining requests granted', async () => {
    const spy = installFetch();
    render(<RegisteredAppScopesPanel />);
    await openPicker();
    fireEvent.click(screen.getByRole('checkbox', { name: /^notify:send / }));
    expect(screen.queryByRole('checkbox', { name: /unknown:legacy/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Submit scope proposal' }));
    const link = await screen.findByRole('link', { name: 'Operator approvals below' });
    await waitFor(() => expect(link.getAttribute('href')).toBe('#approval-appscope_subset'));
    expect(screen.getByText(/Nothing is approved until/)).toBeDefined();
    expect(approvedText()).toBe('Approved service scopes: identity:read');
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([[URL, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appDid: app.appDid, scopes: ['pay:settle'], action: 'grant' }),
    }]]);
    await openPicker();
    expect(screen.getByText(/one scope at a time for independent approve\/deny cards/)).toBeDefined();
    expect((screen.getByRole('checkbox', { name: /^notify:send / }) as HTMLInputElement).checked).toBe(false);
  });

  it.each([401, 403])('hides all registry controls on authorization refusal %s', async (status) => {
    const spy = vi.fn(async () => response({}, status));
    vi.stubGlobal('fetch', spy);
    const { container } = render(<RegisteredAppScopesPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalledOnce());
    expect(container.textContent).toBe('');
  });

  it.each(['http', 'network', 'json', 'shape', 'scope-shape'])('makes a failed %s read explicit, not an empty scope list', async (failure) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'network') throw new Error('offline');
      if (failure === 'http') return response({}, 503);
      if (failure === 'json') return { ok: true, json: async () => { throw new Error('invalid JSON'); } };
      if (failure === 'scope-shape') return response({ apps: [{ ...app, approvedServiceScopes: [123] }], nextCursor: null });
      return response({ apps: [], nextCursor: 123 });
    }));
    render(<RegisteredAppScopesPanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('Registered apps unavailable');
    expect(screen.queryByText('No registered apps.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Propose scopes' })).toBeNull();
  });

  it('retries failed discovery and distinguishes a genuine empty registry', async () => {
    const spy = installFetch();
    spy.mockResolvedValueOnce(response({}, 500)).mockResolvedValue(page([]));
    render(<RegisteredAppScopesPanel />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh registered apps' }));
    expect(await screen.findByText('No registered apps.')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('encodes opaque cursors, appends registry pages and removes the paging control at the end', async () => {
    const cursor = 'opaque+/cursor?= value';
    const second = { ...app, appDid: 'did:imajin:second', name: 'Second app' };
    const spy = installFetch();
    spy.mockResolvedValueOnce(page([app], cursor)).mockResolvedValue(page([second]));
    render(<RegisteredAppScopesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more registered apps' }));
    expect(await screen.findByText(second.name)).toBeDefined();
    expect(screen.getByText(app.name)).toBeDefined();
    expect(spy).toHaveBeenLastCalledWith(`${URL}?cursor=${encodeURIComponent(cursor)}`, { credentials: 'include' });
    expect(screen.queryByRole('button', { name: 'Load more registered apps' })).toBeNull();
  });

  it('keeps loaded rows and an explicit error when a later page fails, permitting paging retry', async () => {
    const spy = installFetch();
    spy.mockResolvedValueOnce(page([app], 'next')).mockResolvedValueOnce(response({}, 502)).mockResolvedValue(page([]));
    render(<RegisteredAppScopesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more registered apps' }));
    await screen.findByRole('alert');
    expect(screen.getByText(app.name)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Load more registered apps' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText(app.name)).toBeDefined();
  });

  it('keeps a page-two proposal and its card link mounted through the proposal refresh', async () => {
    const second = { ...app, appDid: 'did:imajin:second', name: 'Second app' };
    const spy = installFetch();
    spy.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return response({ status: 'pending', proposalId: 'appscope_subset' }, 201);
      return url.includes('?cursor=') ? page([second]) : page([app], 'next');
    });
    render(<RegisteredAppScopesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more registered apps' }));
    const row = (await screen.findByText(second.name)).closest('li')!;
    const picker = within(row);
    await waitFor(() => expect((picker.getByRole('button', { name: 'Propose scopes' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(picker.getByRole('button', { name: 'Propose scopes' }));
    fireEvent.click(picker.getByRole('checkbox', { name: /^notify:send / }));
    fireEvent.click(picker.getByRole('button', { name: 'Submit scope proposal' }));
    await waitFor(() => expect(spy.mock.calls).toHaveLength(5));
    const link = await picker.findByRole('link', { name: 'Operator approvals below' });
    expect(link.getAttribute('href')).toBe('#approval-appscope_subset');
    expect(screen.getByText(second.name)).toBeDefined();
    expect(picker.getByText('Approved service scopes:').textContent).toBe('Approved service scopes: identity:read');
  });

  it('refreshes approved metadata only from the read after the existing decision event', async () => {
    const spy = installFetch();
    render(<RegisteredAppScopesPanel />);
    await openPicker();
    spy.mockResolvedValue(page([{ ...app, approvedServiceScopes: ['identity:read', 'pay:settle'] }]));
    act(() => globalThis.dispatchEvent(new Event(APPROVALS_REFRESH_EVENT)));
    await waitFor(() => expect(approvedText()).toContain('identity:read, pay:settle'));
    expect((screen.getByRole('checkbox', { name: /^pay:settle / }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: /^notify:send / }) as HTMLInputElement).checked).toBe(true);
  });

  it('keeps a denied request unapproved and preserves a manually selected subset across decision refresh', async () => {
    const spy = installFetch();
    render(<RegisteredAppScopesPanel />);
    await openPicker();
    fireEvent.click(screen.getByRole('checkbox', { name: /^notify:send / }));
    spy.mockResolvedValue(page());
    act(() => globalThis.dispatchEvent(new Event(APPROVALS_REFRESH_EVENT)));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Propose scopes' }) as HTMLButtonElement).disabled).toBe(false));
    expect(approvedText()).toBe('Approved service scopes: identity:read');
    expect((screen.getByRole('checkbox', { name: /^notify:send / }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: /^pay:settle / }) as HTMLInputElement).checked).toBe(true);
  });

  it('removes stale approval metadata when decision refresh fails, then hides on session authorization loss', async () => {
    const spy = installFetch();
    render(<RegisteredAppScopesPanel />);
    await screen.findByText(app.name);
    spy.mockResolvedValueOnce(response({}, 503)).mockResolvedValue(response({}, 403));
    act(() => globalThis.dispatchEvent(new Event(APPROVALS_REFRESH_EVENT)));
    await screen.findByRole('alert');
    expect(screen.queryByText(app.name)).toBeNull();
    act(() => globalThis.dispatchEvent(new Event('imajin:session-changed')));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  });

  it('ignores a late response after unmount', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const { unmount } = render(<RegisteredAppScopesPanel />);
    unmount();
    await act(async () => { finish(page()); });
    expect(screen.queryByText(app.name)).toBeNull();
  });
});
