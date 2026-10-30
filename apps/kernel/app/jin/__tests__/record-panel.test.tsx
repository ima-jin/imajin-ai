// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RecordEventRow, RecordEventsPage } from '@/src/lib/jin/record-events';
import { RecordPanel } from '../record-panel';
import JinPage from '../page';

vi.mock('../usage-feed-panel', () => ({ UsageFeedPanel: () => null }));
vi.mock('../decisions-panel', () => ({ DecisionsPanel: () => null }));
vi.mock('../operator-approvals-panel', () => ({ OperatorApprovalsPanel: () => null }));
vi.mock('../vault-keys-panel', () => ({ VaultKeysPanel: () => null }));
vi.mock('../vault-import-panel', () => ({ VaultImportPanel: () => null }));
vi.mock('../cloudflare-panel', () => ({ CloudflarePanel: () => null }));
vi.mock('../access-bearers-panel', () => ({ AccessBearersPanel: () => null }));
vi.mock('../provision-app-panel', () => ({ ProvisionAppPanel: () => null }));
vi.mock('../app-secrets-panel', () => ({ AppSecretsPanel: () => null }));
vi.mock('../registered-apps-panel', () => ({ RegisteredAppsPanel: () => null }));
vi.mock('../registered-app-scopes-panel', () => ({ RegisteredAppScopesPanel: () => null }));
vi.mock('../grants-panel', () => ({ GrantsPanel: () => null }));
vi.mock('../spend-panel', () => ({ SpendPanel: () => null }));
vi.mock('../runs-panel', () => ({ RunsPanel: () => null }));
vi.mock('../front-door-panel', () => ({ FrontDoorPanel: () => null }));
vi.mock('../push-subscribe-button', () => ({ PushSubscribeButton: () => null }));

const person = 'did:imajin:owner';
const agent = `did:imajin:agent-${'a'.repeat(64)}`;

function row(overrides: Partial<RecordEventRow> = {}): RecordEventRow {
  return {
    id: 'person', kind: 'person', who: person, did: person, service: 'kernel', action: 'test.event',
    grantRef: null, approvalRef: null, createdAt: '2026-10-01T00:00:00Z',
    status: null, durationMs: null, payload: null, correlationId: null, parentEventId: null,
    hasOperatorSignature: false, modeCountersign: 'not-applicable', modeCountersignLabel: null,
    ...overrides,
  };
}

function response(events: RecordEventRow[] = [], rest: Partial<RecordEventsPage> = {}) {
  return { ok: true, status: 200, json: async () => ({
    events, total: events.length, limit: 50, offset: 0, ...rest,
  }) } as Response;
}

function fixture(events: RecordEventRow[] = []) {
  const transport = vi.fn().mockResolvedValue(response(events));
  vi.stubGlobal('fetch', transport);
  return transport;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/jin Record lane (#3035)', () => {
  it('mounts Record on /jin rather than leaving an unreachable component', async () => {
    fixture([row()]);
    render(<JinPage />);
    expect(await screen.findByRole('region', { name: 'Record' })).toBeDefined();
    expect(screen.getByText(person)).toBeDefined();
  });
  it.each(['imajin:acting-as-changed', 'imajin:session-changed', 'storage'])('discards org rows and filters on %s without requiring a reload', async eventName => {
    const transport = fixture([row({ who: 'org-private' })]);
    render(<RecordPanel />);
    await screen.findByText('org-private');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'person' } });
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await screen.findByText('org-private');
    transport.mockResolvedValue(response([row()]));
    act(() => { globalThis.dispatchEvent(eventName === 'storage'
      ? new StorageEvent('storage', { key: 'imajin:acting-as' }) : new Event(eventName)); });
    expect(screen.queryByText('org-private')).toBeNull();
    await screen.findByText(person);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(transport).toHaveBeenLastCalledWith('/jin/api/events?limit=50&offset=0', expect.anything());
  });

  it('ignores unrelated storage changes but refreshes when storage is cleared', async () => {
    const transport = fixture([row()]);
    render(<RecordPanel />);
    await screen.findByText(person);
    act(() => { globalThis.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' })); });
    expect(transport).toHaveBeenCalledTimes(1);
    act(() => { globalThis.dispatchEvent(new StorageEvent('storage', { key: null })); });
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  });
  it('loads the cookie-scoped read without a client-selected principal or acting-for header', async () => {
    const transport = fixture([row(), row({ id: 'agent', kind: 'agent', who: agent })]);
    render(<RecordPanel />);
    expect(screen.getByRole('status').textContent).toBe('Loading record…');
    expect(await screen.findAllByTestId('record-row')).toHaveLength(2);
    expect(transport).toHaveBeenCalledWith('/jin/api/events?limit=50&offset=0', {
      credentials: 'include', cache: 'no-store', signal: expect.any(AbortSignal),
    });
    expect(screen.getByText('Person')).toBeDefined();
    expect(screen.getByText('Agent')).toBeDefined();
    expect(screen.getByText(person)).toBeDefined();
    expect(screen.getByText(agent)).toBeDefined();
  });

  it('renders only API-provided authority links and preserves decision evidence', async () => {
    fixture([row({
      kind: 'agent', who: agent, status: 'completed',
      grantRef: { grantId: 'grant/1', href: '/auth/api/grants?grantId=grant%2F1' },
      approvalRef: { proposalId: 'approval/1', href: '/jin?proposalId=approval%2F1', source: 'decision', kind: 'decision:card', chosenOption: 'b' },
      hasOperatorSignature: true, modeCountersignLabel: 'letter not countersigned',
    })]);
    render(<RecordPanel />);
    const entry = await screen.findByTestId('record-row');
    expect(within(entry).getByRole('link', { name: 'Grant · grant/1' }).getAttribute('href')).toBe('/auth/api/grants?grantId=grant%2F1');
    expect(within(entry).getByRole('link', { name: 'Approval · approval/1' }).getAttribute('href')).toBe('/jin?proposalId=approval%2F1');
    expect(within(entry).getByText('Chosen option: b')).toBeDefined();
    expect(within(entry).getByText('Operator signature present')).toBeDefined();
    expect(within(entry).getByText('letter not countersigned')).toBeDefined();
    expect(within(entry).getByText('completed')).toBeDefined();
    expect(entry.querySelector('time')?.dateTime).toBe('2026-10-01T00:00:00Z');
  });

  it('never guesses missing or permission-suppressed grant/approval links from raw payload', async () => {
    fixture([row({ kind: 'agent', who: agent, payload: { grantId: 'hidden', proposalId: 'hidden' } })]);
    render(<RecordPanel />);
    expect(within(await screen.findByTestId('record-row')).queryAllByRole('link')).toEqual([]);
  });

  it('requests person-only and agent-only across the whole record, resetting pagination', async () => {
    const transport = fixture([row()]);
    transport.mockResolvedValueOnce(response([row()], { total: 101 }));
    render(<RecordPanel />);
    await screen.findByTestId('record-row');
    fireEvent.click(screen.getByRole('button', { name: 'Older events' }));
    await waitFor(() => expect(transport).toHaveBeenLastCalledWith('/jin/api/events?limit=50&offset=50', expect.anything()));
    transport.mockResolvedValueOnce(response([row()]));
    fireEvent.change(screen.getByRole('combobox', { name: 'Record actor' }), { target: { value: 'person' } });
    await waitFor(() => expect(transport).toHaveBeenLastCalledWith('/jin/api/events?limit=50&offset=0&kind=person', expect.anything()));
    await screen.findByTestId('record-row');
    transport.mockResolvedValueOnce(response([row({ id: 'agent', kind: 'agent', who: agent })]));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'agent' } });
    await screen.findByText(agent);
    expect(screen.queryByText(person)).toBeNull();
    expect(transport).toHaveBeenLastCalledWith('/jin/api/events?limit=50&offset=0&kind=agent', expect.anything());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await screen.findByText(person);
    expect(transport).toHaveBeenLastCalledWith('/jin/api/events?limit=50&offset=0', expect.anything());
  });

  it('paginates back to newer events and disables controls at the ends', async () => {
    const transport = fixture();
    transport.mockResolvedValueOnce(response([row()], { total: 51 }))
      .mockResolvedValueOnce(response([row({ id: 'older' })], { total: 51, offset: 50 }))
      .mockResolvedValueOnce(response([row()], { total: 51 }));
    render(<RecordPanel />);
    await screen.findByTestId('record-row');
    expect((screen.getByRole('button', { name: 'Newer events' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Older events' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Older events' }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Newer events' }));
    await waitFor(() => expect(transport).toHaveBeenLastCalledWith('/jin/api/events?limit=50&offset=0', expect.anything()));
  });

  it('remounts after switching from the org to personal without retaining org rows or filters', async () => {
    const transport = fixture([row({ who: 'did:imajin:org-only' })]);
    const orgView = render(<RecordPanel />);
    await screen.findByText('did:imajin:org-only');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'agent' } });
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    orgView.unmount();
    transport.mockResolvedValue(response([row()]));
    render(<RecordPanel />);
    await screen.findByText(person);
    expect(screen.queryByText('did:imajin:org-only')).toBeNull();
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(transport).toHaveBeenLastCalledWith('/jin/api/events?limit=50&offset=0', expect.anything());
  });

  it.each([401, 403])('clears visible rows when refreshed access is denied (%s), with no personal fallback', async status => {
    const transport = fixture([row()]);
    render(<RecordPanel />);
    await screen.findByText(person);
    transport.mockResolvedValueOnce(new Response(null, { status }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh record' }));
    await waitFor(() => expect(screen.queryByTestId('record-panel')).toBeNull());
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(['http', 'network', 'json'])('clears stale rows on a %s failure and supports retry', async failure => {
    const transport = fixture([row()]);
    render(<RecordPanel />);
    await screen.findByText(person);
    if (failure === 'network') transport.mockRejectedValueOnce(new Error('offline'));
    else if (failure === 'json') transport.mockResolvedValueOnce(new Response('invalid json'));
    else transport.mockResolvedValueOnce(new Response(null, { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh record' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(person)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh record' }));
    await screen.findByText(person);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the empty state', async () => {
    fixture();
    render(<RecordPanel />);
    expect(await screen.findByText('No matching events.')).toBeDefined();
    expect(screen.getByText('0 matching events')).toBeDefined();
  });

  it('ignores an obsolete response after a filter change even when transport ignores abort', async () => {
    const old = deferred<Response>();
    const transport = fixture();
    transport.mockReturnValueOnce(old.promise).mockResolvedValue(response([row({ who: agent, kind: 'agent' })]));
    render(<RecordPanel />);
    const signal = transport.mock.calls[0][1].signal as AbortSignal;
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'agent' } });
    await screen.findByText(agent);
    await act(async () => { old.resolve(response([row()])); });
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText(person)).toBeNull();
  });

  it('ignores a late body from the org request after a personal remount and aborts on unmount', async () => {
    const oldBody = deferred<RecordEventsPage>();
    const transport = fixture([row()]);
    transport.mockResolvedValueOnce({ ok: true, status: 200, json: () => oldBody.promise });
    const orgView = render(<RecordPanel />);
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const signal = transport.mock.calls[0][1].signal as AbortSignal;
    orgView.unmount();
    render(<RecordPanel />);
    await screen.findByText(person);
    await act(async () => { oldBody.resolve({ events: [row({ who: 'org-private' })], total: 1, limit: 50, offset: 0 }); });
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText('org-private')).toBeNull();
  });

  it('uses wrapping cards and touch-sized controls at phone width, retaining full DIDs and links', async () => {
    vi.stubGlobal('innerWidth', 390);
    fixture([row({ kind: 'agent', who: agent, action: 'a'.repeat(120),
      grantRef: { grantId: 'g'.repeat(120), href: '/auth/api/grants?grantId=long' } })]);
    const { container } = render(<RecordPanel />);
    const entry = await screen.findByTestId('record-row');
    expect(entry.className).toContain('min-w-0');
    expect(screen.getByText(agent).className).toContain('break-all');
    expect(screen.getByRole('link').className).toContain('break-all');
    expect(container.querySelector('table')).toBeNull();
    for (const control of container.querySelectorAll('button, select, a')) expect(control.className).toContain('min-h-11');
    for (const flex of container.querySelectorAll('[class*="flex "]')) expect(flex.className).toContain('flex-wrap');
  });
});
