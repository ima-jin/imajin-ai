// @vitest-environment jsdom
// Lives under apps/ because the root vitest config only runs component tests from there.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
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
});
