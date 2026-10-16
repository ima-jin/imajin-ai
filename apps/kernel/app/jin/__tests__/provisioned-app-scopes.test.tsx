// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SCOPE_VOCABULARY } from '@imajin/auth/scope-vocabulary';
import { ProvisionedAppsList } from '../provisioned-apps-list';
import { APPROVALS_REFRESH_EVENT } from '../approval-anchor';

const APP_DID = 'did:imajin:app-learn';
const URL = '/api/apps/service-scopes';
const scopes = { requestedScopes: ['pay:settle', 'identity:read', 'unknown:legacy'], approvedServiceScopes: ['identity:read'] };

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function installFetch(post = response({ status: 'pending', proposalId: 'appscope_1' }, 201)) {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? post : response(scopes));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderRow(appDid: string | null = APP_DID) {
  return render(<ProvisionedAppsList apps={[{ slug: 'learn', appDid, repoUrl: null, claimed: true }]} reissueBusy={false} onReissue={vi.fn()} />);
}

async function openPicker() {
  const button = screen.getByRole('button', { name: 'Propose scopes' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

async function submit() {
  await openPicker();
  fireEvent.click(screen.getByRole('button', { name: 'Submit scope proposal' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('provisioned app row service scopes', () => {
  it('reads requested and approved scopes through the existing gated GET', async () => {
    const spy = installFetch();
    renderRow();
    await waitFor(() => expect(screen.getByTestId('provisioned-app').textContent).toContain('pay:settle, identity:read, unknown:legacy'));
    expect(screen.getByText('Approved service scopes:').textContent).toBe('Approved service scopes: identity:read');
    expect(spy).toHaveBeenCalledWith(`${URL}?appDid=${encodeURIComponent(APP_DID)}`, { credentials: 'include' });
  });

  it('offers only vocabulary scopes, preselects unapproved requests, and disables approved grants', async () => {
    installFetch();
    renderRow();
    await openPicker();
    const inputs = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(inputs).toHaveLength(SCOPE_VOCABULARY.length);
    expect((screen.getByRole('checkbox', { name: /^pay:settle / }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /^identity:read / }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('checkbox', { name: /unknown:legacy/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /^pay:settle / }));
    expect((screen.getByRole('button', { name: 'Submit scope proposal' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /^notify:send / }));
    expect((screen.getByRole('checkbox', { name: /^notify:send / }) as HTMLInputElement).checked).toBe(true);
  });

  it.each([200, 201])('posts grant only and links to the pending card (%s)', async (status) => {
    const spy = installFetch(response({ status: 'pending', proposalId: 'appscope_1' }, status));
    const refresh = vi.fn();
    globalThis.addEventListener(APPROVALS_REFRESH_EVENT, refresh, { once: true });
    renderRow();
    await submit();
    const link = await screen.findByRole('link', { name: 'Operator approvals below' });
    expect(link.getAttribute('href')).toBe('#approval-appscope_1');
    expect(screen.getByRole('status').textContent).toContain('Nothing is approved until you countersign there.');
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([[URL, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appDid: APP_DID, scopes: ['pay:settle'], action: 'grant' }),
    }]]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByText('Approved service scopes:').textContent).toBe('Approved service scopes: identity:read');
  });

  it.each([
    [400, 'Unknown scopes: stale:scope'],
    [403, 'Only the app owner or the node operator may do this'],
    [404, 'Unknown app DID'],
  ])('shows %s errors inline and keeps the row usable', async (status, error) => {
    installFetch(response({ error }, status));
    renderRow();
    await submit();
    expect((await screen.findByRole('alert')).textContent).toBe(error);
    expect(screen.getByTestId('provisioned-app').textContent).toContain('learn');
    expect((screen.getByRole('button', { name: 'Submit scope proposal' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    [response({ status: 'already-approved' }), 'These service scopes are already approved.'],
    [response({ status: 'unexpected' }), 'Unexpected response from apps.service-scopes'],
    [response({}, 500), 'Failed to propose service scopes (500)'],
    [{ ok: false, status: 502, json: async () => { throw new Error('not json'); } } as unknown as Response, 'Failed to propose service scopes (502)'],
  ])('handles non-pending responses without claiming approval', async (post, message) => {
    installFetch(post);
    renderRow();
    await submit();
    expect(await screen.findByText(message)).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('handles a network failure and permits retry', async () => {
    const spy = installFetch();
    spy.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') throw new Error('offline');
      return response(scopes);
    });
    renderRow();
    await submit();
    expect((await screen.findByRole('alert')).textContent).toContain('Network error');
  });

  it.each(['refused', 'offline', 'malformed', 'missing'])('degrades a %s scope read to empty scopes', async (failure) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'offline') throw new Error('offline');
      if (failure === 'refused') return response({}, 403);
      if (failure === 'malformed') return response({ requestedScopes: 'bad', approvedServiceScopes: [1] });
      return response({});
    }));
    renderRow();
    await openPicker();
    expect(screen.getByText('Requested scopes:').textContent).toBe('Requested scopes: None');
    expect(screen.getByText('Approved service scopes:').textContent).toBe('Approved service scopes: None');
  });

  it('ignores a scope read completed after unmount', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const { unmount } = renderRow();
    unmount();
    await act(async () => { finish(response(scopes)); });
    expect(screen.queryByTestId('provisioned-app')).toBeNull();
  });

  it('keeps a provision without an app DID visible without fetching scopes', () => {
    const spy = installFetch();
    renderRow(null);
    expect(screen.getByTestId('provisioned-app').textContent).toContain('learn');
    expect(screen.queryByRole('button', { name: 'Propose scopes' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
