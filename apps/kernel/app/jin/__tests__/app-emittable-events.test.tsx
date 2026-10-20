// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppEmittableEvents } from '../app-emittable-events';
import { ProvisionedAppsList } from '../provisioned-apps-list';
import { RegisteredAppScopesPanel } from '../registered-app-scopes-panel';

const APP_DID = 'did:imajin:events';
const APP_ID = 'app_events';
const READ_URL = `/api/apps/service-scopes?appDid=${encodeURIComponent(APP_DID)}&includeEvents=true`;
const PATCH_URL = `/api/admin/registry/apps/${APP_ID}`;
const metadata = {
  appId: APP_ID,
  declaredEmittableEvents: ['event.rsvp', 'ticket.purchased'],
  approvedEmittableEvents: ['event.rsvp', 'legacy.sent'],
};
const scopeState = { requestedScopes: [], approvedServiceScopes: [] };

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function installFetch(initial = metadata) {
  let current = initial;
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const { emittableEvents } = JSON.parse(init.body as string) as { emittableEvents: string[] };
      current = { ...current, approvedEmittableEvents: emittableEvents };
      return response({ ok: true, app: { id: APP_ID, emittableEvents } });
    }
    return response(current);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function openPicker() {
  const button = screen.getByRole('button', { name: 'Approve events' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save event approvals' }));
}

function approvedText() {
  return screen.getByText('Approved emittable events:').textContent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('app row emittable-event approvals', () => {
  it('shows declarations separately and preserves approved events not in the manifest', async () => {
    const spy = installFetch();
    render(<AppEmittableEvents appDid={APP_DID} />);
    await openPicker();
    expect(screen.getByText('Declared emittable events:').textContent).toContain('event.rsvp, ticket.purchased');
    expect(approvedText()).toContain('event.rsvp, legacy.sent');
    expect((screen.getByRole('checkbox', { name: /legacy.sent/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /ticket.purchased/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Admin approval is immediate/)).toBeDefined();
    expect(spy).toHaveBeenCalledWith(READ_URL, { credentials: 'include' });
  });

  it.each([false, true])('replaces approvals with the declared set or a subset (subset=%s)', async (subset) => {
    const spy = installFetch();
    render(<AppEmittableEvents appDid={APP_DID} />);
    await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Select declared set' }));
    if (subset) fireEvent.click(screen.getByRole('checkbox', { name: /event.rsvp/ }));
    const expected = subset ? ['ticket.purchased'] : metadata.declaredEmittableEvents;
    await save();
    await waitFor(() => expect(approvedText()).toBe(`Approved emittable events: ${expected.join(', ')}`));
    expect(screen.getByRole('status').textContent).toContain('effective immediately');
    expect(spy).toHaveBeenCalledWith(PATCH_URL, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emittableEvents: expected }),
    });
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('withdraws every approval with an explicit empty selection', async () => {
    const spy = installFetch();
    render(<AppEmittableEvents appDid={APP_DID} />);
    await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    await save();
    await waitFor(() => expect(approvedText()).toBe('Approved emittable events: None'));
    expect(spy).toHaveBeenCalledWith(PATCH_URL, expect.objectContaining({ body: '{"emittableEvents":[]}' }));
  });

  it('distinguishes genuinely empty declarations from missing manifests', async () => {
    installFetch({ ...metadata, declaredEmittableEvents: [], approvedEmittableEvents: [] });
    render(<AppEmittableEvents appDid={APP_DID} />);
    await openPicker();
    expect(screen.getByText('Declared emittable events:').textContent).toBe('Declared emittable events: None');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it.each([undefined, 'Manifest could not be read.'])('keeps approvals visible and revocable when declarations are unavailable (%s)', async (eventDeclarationError) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...metadata, declaredEmittableEvents: null, eventDeclarationError })));
    render(<AppEmittableEvents appDid={APP_DID} />);
    await openPicker();
    expect(screen.getByText('Declared emittable events:').textContent).toContain('Unavailable');
    expect(approvedText()).toContain('legacy.sent');
    expect((screen.getByRole('button', { name: 'Select declared set' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it.each([
    [401, 'Not authorized'],
    [403, 'Not authorized'],
    [400, 'Rejected by validator'],
    [500, 'Event approval failed (500)'],
    [502, 'Rejected by validator'],
  ] as const)('shows PATCH %s errors without claiming approval', async (status, expected) => {
    const spy = installFetch();
    spy.mockImplementation(async (_url, init) => init?.method === 'PATCH'
      ? response(status === 500 ? {} : { error: 'Rejected by validator' }, status)
      : response(metadata));
    render(<AppEmittableEvents appDid={APP_DID} />);
    await openPicker();
    await save();
    expect((await screen.findByRole('alert')).textContent).toContain(expected);
    expect(approvedText()).toContain('legacy.sent');
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save event approvals' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['network', 'json', 'shape', 'wrong-app', 'null'])('handles a %s PATCH failure and allows retry', async (failure) => {
    const spy = installFetch();
    spy.mockImplementation(async (_url, init) => {
      if (init?.method !== 'PATCH') return response(metadata);
      if (failure === 'network') throw new Error('offline');
      if (failure === 'json') return { ok: false, status: 502, json: async () => { throw new Error('not json'); } } as Response;
      if (failure === 'null') return response(null);
      return response({ app: { id: failure === 'wrong-app' ? 'other' : APP_ID, emittableEvents: failure === 'shape' ? [1] : [] } });
    });
    render(<AppEmittableEvents appDid={APP_DID} />);
    await openPicker();
    await save();
    await screen.findByRole('alert');
    expect(approvedText()).toContain('legacy.sent');
    expect(screen.queryByRole('status')).toBeNull();
    spy.mockImplementation(async () => response({ app: { id: APP_ID, emittableEvents: [] } }));
    await save();
    await screen.findByRole('status');
  });

  it.each([401, 403, 503, 'network', 'malformed', 'null', 'missing'])('fails closed on a %s read and retries', async (failure) => {
    const spy = vi.fn(async () => {
      if (failure === 'network') throw new Error('offline');
      if (typeof failure === 'number') return response({}, failure);
      if (failure === 'null') return response(null);
      if (failure === 'missing') return response({});
      return response({ ...metadata, approvedEmittableEvents: [123] });
    });
    vi.stubGlobal('fetch', spy);
    render(<AppEmittableEvents appDid={APP_DID} />);
    await screen.findByRole('alert');
    expect(approvedText()).toBe('Approved emittable events: Unavailable');
    expect((screen.getByRole('button', { name: 'Approve events' }) as HTMLButtonElement).disabled).toBe(true);
    spy.mockResolvedValue(response(metadata));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh events' }));
    await openPicker();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables saving while pending and ignores late writes after session change', async () => {
    let finish!: (value: Response) => void;
    const spy = installFetch();
    spy.mockImplementation(async (_url, init) => init?.method === 'PATCH'
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : response(metadata));
    render(<AppEmittableEvents appDid={APP_DID} />);
    await openPicker();
    await save();
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true);
    spy.mockResolvedValue(response({}, 403));
    act(() => globalThis.dispatchEvent(new Event('imajin:session-changed')));
    await screen.findByRole('alert');
    await act(async () => { finish(response({ app: { id: APP_ID, emittableEvents: [] } })); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(approvedText()).toContain('Unavailable');
  });

  it('ignores a late read after unmount', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const { unmount } = render(<AppEmittableEvents appDid={APP_DID} />);
    unmount();
    await act(async () => { finish(response(metadata)); });
    expect(screen.queryByText('Approved emittable events:')).toBeNull();
  });

  it('renders the real event control next to provisioned-app scopes', async () => {
    const spy = installFetch();
    spy.mockImplementation(async (url) => response(url.includes('includeEvents') ? metadata : scopeState));
    render(<ProvisionedAppsList apps={[{ slug: 'events', appDid: APP_DID, repoUrl: null, claimed: true }]} reissueBusy={false} onReissue={vi.fn()} />);
    await openPicker();
    expect(screen.getByRole('button', { name: 'Propose scopes' })).toBeDefined();
    expect(approvedText()).toContain('legacy.sent');
  });

  it('renders the same control for self-registered apps without a provision ledger', async () => {
    const spy = installFetch();
    spy.mockImplementation(async (url) => response(url.includes('includeEvents') ? metadata : {
      apps: [{ ...scopeState, appDid: APP_DID, name: 'Self registered', status: 'active', approvalId: null, approvedAt: null }],
      nextCursor: null,
    }));
    render(<RegisteredAppScopesPanel />);
    await screen.findByText('Self registered');
    await openPicker();
    expect(approvedText()).toContain('legacy.sent');
  });
});
