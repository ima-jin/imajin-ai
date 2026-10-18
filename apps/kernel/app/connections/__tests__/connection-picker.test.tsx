// @vitest-environment jsdom
// Lives under apps/ because the root vitest config only runs component tests from there.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { ConnectionPicker } from '../../../../../packages/ui/src/connection-picker';

const CONNECTIONS_URL = '/connections/api/connections';

function stubFetch(response: { ok: boolean; status?: number; body?: unknown } | Error) {
  const spy = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, status: response.status ?? 200, json: async () => response.body };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const BOB = { did: 'did:imajin:bob', name: 'Bob', handle: 'bob' };
const jsonResponse = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

function requestFetch(results = [BOB]) {
  const spy = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return jsonResponse({ invite: { code: 'direct-code' } });
    if (url.includes('/search')) return jsonResponse({ results });
    return jsonResponse({ connections: [] });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function typeQuery(query = '@bob') {
  await screen.findByText('No connections available.');
  vi.useFakeTimers();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: query } });
}

async function debounce() {
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

describe('ConnectionPicker — identity requests (#2944)', () => {
  it('debounces handle search, strips @, and sends an explicit request without selecting', async () => {
    const fetch = requestFetch();
    const onSelect = vi.fn();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={onSelect} />);
    await typeQuery('@bo');
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@bob' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetch).toHaveBeenLastCalledWith('/auth/api/search?q=bob', expect.objectContaining({ credentials: 'include' }));
    expect(screen.getByText('Bob')).toBeDefined();
    expect(screen.getByText('@bob')).toBeDefined();
    expect(screen.getByText(BOB.did)).toBeDefined();
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send connection request' })); });
    expect(fetch).toHaveBeenLastCalledWith('/connections/api/invites', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ toDid: BOB.did }), credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(screen.getByRole('status').textContent).toContain('awaiting acceptance');
    expect(screen.queryByRole('button')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@other' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@bob' } });
    await debounce();
    expect(screen.getByRole('status').textContent).toContain('pending');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['https://kernel.example/connections/api/connections', 'https://kernel.example'],
    ['//kernel.example/connections/api/connections', '//kernel.example'],
  ])('looks up a DID using SDK connections URL %s', async (connectionsUrl, origin) => {
    const fetch = requestFetch();
    render(<ConnectionPicker connectionsUrl={connectionsUrl} onSelect={vi.fn()} />);
    await typeQuery('did:imajin:MixedCase');
    await debounce();
    const searchOrigin = origin.startsWith('//') ? `${globalThis.location.protocol}${origin}` : origin;
    expect(fetch).toHaveBeenLastCalledWith(`${searchOrigin}/auth/api/search?q=did%3Aimajin%3AMixedCase`, expect.anything());
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(fetch).toHaveBeenLastCalledWith(`${origin}/connections/api/invites`, expect.objectContaining({ method: 'POST' }));
  });

  it('allows explicit search and invite endpoints', async () => {
    const fetch = requestFetch();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} searchUrl="https://auth.example/search?limit=5"
      invitesUrl="https://connect.example/invites" onSelect={vi.fn()} />);
    await typeQuery();
    await debounce();
    expect(fetch).toHaveBeenLastCalledWith('https://auth.example/search?limit=5&q=bob', expect.anything());
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(fetch).toHaveBeenLastCalledWith('https://connect.example/invites', expect.objectContaining({ method: 'POST' }));
  });

  it('does not search below two characters or while disabled', async () => {
    const fetch = requestFetch();
    const props = { connectionsUrl: CONNECTIONS_URL, onSelect: vi.fn() };
    const { rerender } = render(<ConnectionPicker {...props} />);
    await typeQuery('@b');
    await debounce();
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@bob' } });
    rerender(<ConnectionPicker {...props} disabled />);
    await debounce();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('filters existing and explicitly excluded DIDs out of identity results', async () => {
    const alice = { did: 'did:imajin:alice', name: 'Alice', handle: 'alice', avatar: null };
    const excluded = { did: 'did:imajin:hidden', name: 'Hidden', handle: 'hidden' };
    const fetch = requestFetch([BOB, alice, excluded]);
    fetch.mockImplementationOnce(async () => jsonResponse({ connections: [alice] }));
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} excludeDids={[excluded.did]} onSelect={vi.fn()} />);
    await screen.findByText('Alice');
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bob' } });
    await debounce();
    expect(screen.getByText('Bob')).toBeDefined();
    expect(screen.queryByText('Alice')).toBeNull();
    expect(screen.queryByText('Hidden')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it.each(['http', 'network', 'json'])('shows lookup %s failures without selectable identities', async failure => {
    const fetch = requestFetch();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);
    await typeQuery();
    fetch.mockImplementationOnce(async () => {
      if (failure === 'network') throw new TypeError('offline');
      if (failure === 'json') return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } };
      return jsonResponse({}, false);
    });
    await debounce();
    expect(screen.getByRole('alert').textContent).toContain('Identity search is unavailable');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows an empty lookup state', async () => {
    requestFetch([]);
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);
    await typeQuery();
    await debounce();
    expect(screen.getByText('No matching identities.')).toBeDefined();
  });

  it.each(['http', 'network'])('keeps request %s failures retryable and never calls onSelect', async failure => {
    const fetch = requestFetch();
    const onSelect = vi.fn();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={onSelect} />);
    await typeQuery();
    await debounce();
    fetch.mockImplementationOnce(async () => {
      if (failure === 'network') throw new TypeError('offline');
      return jsonResponse({}, false);
    });
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByRole('alert').textContent).toContain('Could not send connection request');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('aborts and ignores stale lookup responses after query changes', async () => {
    const fetch = requestFetch();
    let resolve!: (value: ReturnType<typeof jsonResponse>) => void;
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);
    await typeQuery();
    fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await debounce();
    const signal = fetch.mock.calls[1][1]?.signal;
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@charlie' } });
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve(jsonResponse({ results: [BOB] })); });
    expect(screen.queryByText('Bob')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('clears query/results and reloads accepted connections after an act-as identity change', async () => {
    const fetch = requestFetch();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);
    await typeQuery();
    await debounce();
    expect(screen.getByText('Bob')).toBeDefined();
    await act(async () => { globalThis.dispatchEvent(new CustomEvent('imajin:acting-as-changed')); });
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Bob')).toBeNull();
    expect(fetch).toHaveBeenLastCalledWith(CONNECTIONS_URL, { credentials: 'include' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['query', 'identity', 'act-as', 'disabled', 'url'])('aborts stale sending actions after %s changes', async change => {
    const fetch = requestFetch();
    const onSelect = vi.fn();
    const props = { connectionsUrl: CONNECTIONS_URL, onSelect };
    const { rerender } = render(<ConnectionPicker {...props} />);
    await typeQuery();
    await debounce();
    let resolve!: (value: ReturnType<typeof jsonResponse>) => void;
    fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button'));
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button'));
    expect(fetch).toHaveBeenCalledTimes(3);
    const signal = fetch.mock.calls[2][1]?.signal;
    if (change === 'query') fireEvent.change(screen.getByRole('textbox'), { target: { value: '@other' } });
    if (change === 'identity') rerender(<ConnectionPicker {...props} identityKey="did:imajin:org" />);
    if (change === 'act-as') act(() => { globalThis.dispatchEvent(new CustomEvent('imajin:acting-as-changed')); });
    if (change === 'disabled') rerender(<ConnectionPicker {...props} disabled />);
    if (change === 'url') rerender(<ConnectionPicker {...props} connectionsUrl={`${CONNECTIONS_URL}?org=1`} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve(jsonResponse({ invite: { code: 'old' } })); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

const labelledConnections = [
  { did: 'did:imajin:v', name: 'Vendor', handle: 'vendor', avatar: null, relationshipLabel: 'vendor' },
  { did: 'did:imajin:c', name: 'Client', handle: 'client', avatar: null, relationshipLabel: 'client' },
  { did: 'did:imajin:p', name: 'Partner', handle: 'partner', avatar: null, relationshipLabel: 'partner' },
  { did: 'did:imajin:o', name: 'Other party', handle: 'other', avatar: null, relationshipLabel: 'other' },
  { did: 'did:imajin:u', name: 'Unlabelled', handle: null, avatar: null, relationshipLabel: null },
  { did: 'did:imajin:l', name: 'Legacy', handle: null, avatar: null },
];

describe('ConnectionPicker — opt-in relationship labels (#2945)', () => {
  it('looks up text misses, not accepted connections hidden by a label filter', async () => {
    const fetch = requestFetch();
    fetch.mockImplementationOnce(async () => jsonResponse({ connections: labelledConnections }));
    const onSelect = vi.fn();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={onSelect} relationshipLabels />);
    await screen.findByText('Vendor');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Clients' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@vendor' } });
    await debounce();
    expect(screen.getByText('No matching connections.')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Send connection request' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@bob' } });
    await debounce();
    expect(fetch).toHaveBeenLastCalledWith('/auth/api/search?q=bob', expect.anything());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send connection request' })); });
    expect(screen.getByRole('status').textContent).toContain('awaiting acceptance');
    expect(screen.getByRole('button', { name: 'Clients' }).getAttribute('aria-pressed')).toBe('true');
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('keeps all visible by default with clients first and the remaining order stable', async () => {
    stubFetch({ ok: true, body: { connections: labelledConnections } });
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} relationshipLabels />);
    await screen.findByText('Vendor');
    const rows = screen.getAllByRole('button').filter(button => !button.hasAttribute('aria-pressed'));
    expect(rows.map(button => button.textContent)).toEqual([
      expect.stringContaining('Client'), expect.stringContaining('Vendor'), expect.stringContaining('Partner'),
      expect.stringContaining('Other party'), expect.stringContaining('Unlabelled'), expect.stringContaining('Legacy'),
    ]);
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
  });

  it.each([
    ['Clients', ['Client']], ['Vendors', ['Vendor']], ['Partners', ['Partner']],
    ['Other', ['Other party']], ['Unset', ['Unlabelled', 'Legacy']],
  ])('filters by %s with one click', async (filter, names) => {
    stubFetch({ ok: true, body: { connections: labelledConnections } });
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} relationshipLabels />);
    await screen.findByText('Vendor');
    fireEvent.click(screen.getByRole('button', { name: filter as string }));
    const rows = screen.getAllByRole('button').filter(button => !button.hasAttribute('aria-pressed'));
    expect(rows).toHaveLength(names.length);
    for (const name of names) expect(screen.getByText(name)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Vendor')).toBeDefined();
  });

  it('combines labels with search and exclusions and preserves the full selection', async () => {
    stubFetch({ ok: true, body: { connections: labelledConnections } });
    const onSelect = vi.fn();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={onSelect} relationshipLabels excludeDids={['did:imajin:l']} />);
    await screen.findByText('Client');
    fireEvent.click(screen.getByRole('button', { name: 'Unset' }));
    expect(screen.queryByText('Legacy')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching connections.')).toBeDefined();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unlabel' } });
    fireEvent.click(screen.getByRole('button', { name: /Unlabelled/ }));
    expect(onSelect).toHaveBeenCalledWith(labelledConnections[4]);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('does not show labels, filters or reorder existing callers', async () => {
    stubFetch({ ok: true, body: { connections: labelledConnections } });
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);
    await screen.findByText('Vendor');
    expect(screen.queryByRole('group', { name: 'Filter relationships' })).toBeNull();
    expect(screen.queryByText('client')).toBeNull();
    expect(screen.getAllByRole('button')[0].textContent).toContain('Vendor');
  });

  it('disables filter controls and selection when disabled', async () => {
    stubFetch({ ok: true, body: { connections: labelledConnections } });
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} relationshipLabels disabled />);
    await screen.findByText('Vendor');
    expect(screen.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe('ConnectionPicker — load failures (#2651)', () => {
  it.each([
    [401, 'Your session has expired. Sign in again to load connections.'],
    [403, "You don't have permission to view these connections."],
    [500, 'Failed to load connections (HTTP 500).'],
  ])('shows an error, not the empty state, for HTTP %i', async (status, message) => {
    stubFetch({ ok: false, status, body: { error: 'nope' } });
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.queryByText('No connections available.')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('shows the generic error when the request itself fails', async () => {
    stubFetch(new TypeError('network down'));
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load connections');
    expect(screen.queryByText('No connections available.')).toBeNull();
  });

  it('shows the generic error when an OK response is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })));
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load connections');
  });

  it('clears a previous error when the URL changes and the reload succeeds', async () => {
    stubFetch({ ok: false, status: 403 });
    const { rerender } = render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);
    await screen.findByRole('alert');

    stubFetch({ ok: true, body: { connections: [{ did: 'did:imajin:a', name: 'Alice', handle: 'alice', avatar: null }] } });
    rerender(<ConnectionPicker connectionsUrl={`${CONNECTIONS_URL}?retry=1`} onSelect={vi.fn()} />);

    await screen.findByText('Alice');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ConnectionPicker — empty state (#2651)', () => {
  it('defaults to "No connections available."', async () => {
    stubFetch({ ok: true, body: { connections: [] } });
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} />);

    expect(await screen.findByText('No connections available.')).toBeDefined();
  });

  it('shows a custom emptyMessage when there are no connections', async () => {
    stubFetch({ ok: true, body: { connections: [] } });
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} emptyMessage="Nobody here yet." />);

    expect(await screen.findByText('Nobody here yet.')).toBeDefined();
    expect(screen.queryByText('No connections available.')).toBeNull();
  });

  it('treats a response with no connections key as empty', async () => {
    stubFetch({ ok: true, body: {} });
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} emptyMessage="Nobody here yet." />);

    expect(await screen.findByText('Nobody here yet.')).toBeDefined();
  });

  it('keeps "No matching connections." for a search with no hits, not emptyMessage', async () => {
    stubFetch({ ok: true, body: { connections: [{ did: 'did:imajin:a', name: 'Alice', handle: 'alice', avatar: null }] } });
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={vi.fn()} emptyMessage="Nobody here yet." />);
    await screen.findByText('Alice');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zzz' } });

    expect(screen.getByText('No matching connections.')).toBeDefined();
    expect(screen.queryByText('Nobody here yet.')).toBeNull();
  });
});

describe('ConnectionPicker — selection', () => {
  it('lists connections and reports the selected one', async () => {
    const connection = { did: 'did:imajin:a', name: 'Alice', handle: 'alice', avatar: null };
    stubFetch({ ok: true, body: { connections: [connection] } });
    const onSelect = vi.fn();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={onSelect} />);

    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(connection));
  });

  it('does not select excluded or disabled accepted connections', async () => {
    const alice = { did: 'did:imajin:a', name: 'Alice', handle: 'alice', avatar: null };
    stubFetch({ ok: true, body: { connections: [alice, { ...alice, did: 'did:imajin:b', name: 'Bob' }] } });
    const onSelect = vi.fn();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} excludeDids={[alice.did]} disabled onSelect={onSelect} />);
    await screen.findByText('Bob');
    expect(screen.queryByText('Alice')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(['@alice', 'did:imajin:a'])('matches accepted connections by %s without a lookup', async query => {
    const connection = { did: 'did:imajin:a', name: 'Alice', handle: 'alice', avatar: null };
    const fetch = stubFetch({ ok: true, body: { connections: [connection] } });
    const onSelect = vi.fn();
    render(<ConnectionPicker connectionsUrl={CONNECTIONS_URL} onSelect={onSelect} />);
    await screen.findByText('Alice');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: query } });
    fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
    expect(onSelect).toHaveBeenCalledWith(connection);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
