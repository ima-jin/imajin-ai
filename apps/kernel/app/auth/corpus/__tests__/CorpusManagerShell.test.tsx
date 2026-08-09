// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import CorpusManagerShell from '../components/CorpusManagerShell';

const DID = 'did:imajin:alice';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CorpusManagerShell — sources list', () => {
  it('renders loaded sources with thread counts and a fresh indicator', async () => {
    const recentSync = new Date().toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          sources: [{ source: 'github:ima-jin/imajin-ai', lastSync: recentSync, threadCount: 42 }],
          threadCount: 42,
        }),
      ),
    );

    render(<CorpusManagerShell did={DID} />);

    expect(await screen.findByText('github:ima-jin/imajin-ai')).toBeDefined();
    expect(screen.getByText('42 threads')).toBeDefined();
    expect(screen.getByText('Synced recently')).toBeDefined();
  });

  it('renders an empty state when no sources are loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sources: [], threadCount: 0 })));

    render(<CorpusManagerShell did={DID} />);

    expect(await screen.findByText('No sources loaded yet.')).toBeDefined();
  });

  it('shows the total thread count and per-source count in usage stats', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          sources: [
            { source: 'github:ima-jin/imajin-ai', lastSync: new Date().toISOString(), threadCount: 10 },
            { source: 'local:/home/me/notes', lastSync: new Date().toISOString(), threadCount: 5 },
          ],
          threadCount: 15,
        }),
      ),
    );

    render(<CorpusManagerShell did={DID} />);

    await waitFor(() => {
      expect(screen.getByText('15')).toBeDefined();
    });
    expect(screen.getByText(/indexed across 2 sources/)).toBeDefined();
  });

  it('renders stale-source warnings in red', async () => {
    const staleSync = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          sources: [{ source: 'github:ima-jin/imajin-ai', lastSync: staleSync, threadCount: 3 }],
          threadCount: 3,
        }),
      ),
    );

    render(<CorpusManagerShell did={DID} />);

    expect(await screen.findByText('Stale')).toBeDefined();
    expect(screen.getByText(/Not synced in 10 days/)).toBeDefined();
  });

  it('surfaces a load error when the status fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Corpus status unavailable' }, false, 502)));

    render(<CorpusManagerShell did={DID} />);

    expect(await screen.findByText('Corpus status unavailable')).toBeDefined();
  });
});

describe('CorpusManagerShell — load source form', () => {
  it('submits the composed source and sourceType to the load endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/auth/corpus/api/status') {
        return jsonResponse({ sources: [], threadCount: 0 });
      }
      if (url === '/auth/corpus/api/load') {
        return jsonResponse({ ingested: 0 }, true, 201);
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CorpusManagerShell did={DID} />);

    await screen.findByText('No sources loaded yet.');
    fireEvent.click(screen.getByText('Load new source'));

    const identifierInput = screen.getByPlaceholderText(/owner\/repo/);
    fireEvent.change(identifierInput, { target: { value: 'ima-jin/imajin-ai' } });
    fireEvent.click(screen.getByText('Load source'));

    await waitFor(() => {
      const loadCall = fetchMock.mock.calls.find(([url]) => url === '/auth/corpus/api/load');
      expect(loadCall).toBeDefined();
      const [, init] = loadCall!;
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        sourceType: 'github',
        source: 'github:ima-jin/imajin-ai',
      });
    });

    expect(await screen.findByText(/Started loading github:ima-jin\/imajin-ai/)).toBeDefined();
  });

  it('shows an error message when the load request fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/auth/corpus/api/status') return jsonResponse({ sources: [], threadCount: 0 });
      if (url === '/auth/corpus/api/load') return jsonResponse({ error: 'body must be a ThreadDocument[]' }, false, 400);
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CorpusManagerShell did={DID} />);

    await screen.findByText('No sources loaded yet.');
    fireEvent.click(screen.getByText('Load new source'));
    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/), { target: { value: 'ima-jin/imajin-ai' } });
    fireEvent.click(screen.getByText('Load source'));

    expect(await screen.findByText('body must be a ThreadDocument[]')).toBeDefined();
  });
});

describe('CorpusManagerShell — sync and remove actions', () => {
  it('triggers a sync request for the clicked source', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/auth/corpus/api/status') {
        return jsonResponse({
          sources: [{ source: 'github:ima-jin/imajin-ai', lastSync: new Date().toISOString(), threadCount: 1 }],
          threadCount: 1,
        });
      }
      if (url === '/auth/corpus/api/sync') return jsonResponse({ synced: true });
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CorpusManagerShell did={DID} />);

    await screen.findByText('github:ima-jin/imajin-ai');
    fireEvent.click(screen.getByText('Sync'));

    await waitFor(() => {
      const syncCall = fetchMock.mock.calls.find(([url]) => url === '/auth/corpus/api/sync');
      expect(syncCall).toBeDefined();
    });
  });

  it('requires confirmation before removing a source', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/auth/corpus/api/status') {
        return jsonResponse({
          sources: [{ source: 'github:ima-jin/imajin-ai', lastSync: new Date().toISOString(), threadCount: 1 }],
          threadCount: 1,
        });
      }
      if (url === '/auth/corpus/api/source') return jsonResponse({ deleted: 1 });
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CorpusManagerShell did={DID} />);

    await screen.findByText('github:ima-jin/imajin-ai');
    fireEvent.click(screen.getByTitle('Remove source'));

    expect(fetchMock.mock.calls.some(([url]) => url === '/auth/corpus/api/source')).toBe(false);

    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/auth/corpus/api/source')).toBe(true);
    });
  });
});
