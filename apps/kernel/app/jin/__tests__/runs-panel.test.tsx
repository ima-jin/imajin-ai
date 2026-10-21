// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RunsPanel } from '../runs-panel';
import { RunsPanelDetail } from '../runs-panel-detail';
import { runLoop } from '@/src/lib/jin/__tests__/runs-fixture';
vi.mock('../operator-approvals-panel', () => ({
  useRunApprovals: () => ({ approvals: [], error: null, busyId: '', decisionsLocked: false, handleDecide: vi.fn(), handleArchive: vi.fn() }),
  ApprovalCardRow: () => null,
  ApprovalControllerNotices: () => null,
}));

function setFetch(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => options?.cache === 'no-store'
    ? Promise.resolve(response({ isOperator: true, lastStepEventAt: null, detail: { horizon: { steps: [], depth: 0, targetDepth: 12 } }, commandTarget: { available: false } }))
    : url === '/api/loops/surfaces'
    ? Promise.resolve(response({ conflicts: [] })) : fetcher(url, options));
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function page(loops = [runLoop()], nextCursor: string | null = null) {
  return { isOperator: true, page: { loops, nextCursor, hasNextPage: nextCursor !== null } };
}

function history(loop = runLoop()) {
  return {
    isOperator: true,
    detail: {
      loop,
      events: [
        { id: 'e1', type: 'loop.started', occurredAt: loop.startedAt, issuer: 'did:imajin:node', payload: { summary: 'Started work' } },
        { id: 'e2', type: 'loop.progress', occurredAt: loop.lastSeenAt, issuer: 'did:imajin:node', payload: {} },
      ],
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RunsPanel', () => {
  it.each([
    response({ isOperator: false, page: null }),
    response({}, 401),
    response({}, 403),
    response({}, 500),
  ])('renders no chrome when the initial response does not establish operator status', async (result) => {
    const fetcher = vi.fn().mockResolvedValue(result);
    setFetch(fetcher);
    const { container } = render(<RunsPanel />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('shows a mobile single-column lane, orders blockers first and opens signed history', async () => {
    const blocked = runLoop({ loopId: 'blocked', summary: 'Awaiting human review', state: 'waiting', lastEventType: 'loop.blocked' });
    const fetcher = vi.fn((url: string) => {
      if (url.includes('ancestor=')) return Promise.resolve(response(page([blocked])));
      if (url.endsWith('/blocked')) return Promise.resolve(response(history(blocked)));
      return Promise.resolve(response(page([runLoop(), blocked])));
    });
    setFetch(fetcher);
    const { container } = render(<RunsPanel />);
    const cards = await screen.findAllByTestId('run-card');
    expect(cards[0].textContent).toContain('Awaiting human review');
    expect(cards[0].textContent).toContain('Needs attention');
    fireEvent.click(within(cards[0]).getByRole('button'));
    const detail = await screen.findByTestId('run-detail');
    expect(detail.textContent).toContain('ima-jin/imajin-ai#2290');
    expect(within(detail).getAllByText(/Signed by/)).toHaveLength(2);
    expect(within(detail).getAllByRole('list')).toHaveLength(2);
    expect(detail.textContent).toContain('Root loop');
    expect(detail.textContent?.indexOf('loop.started')).toBeLessThan(detail.textContent?.indexOf('loop.progress') ?? 0);
    expect(container.querySelector('table')).toBeNull();
    expect(container.innerHTML).not.toMatch(/overflow-x-(auto|scroll)|\b(?:min-)?w-\[\d+px\]/);
    expect(cards[0].className).toContain('min-w-0');
    expect(within(cards[0]).getByRole('button', { expanded: true }).className).toContain('min-h-11');
    fireEvent.click(within(cards[0]).getByRole('button', { expanded: true }));
    expect(screen.queryByTestId('run-detail')).toBeNull();
  });

  it('loads additional pages without duplicate cards and clears all data on revocation', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(page([runLoop()], 'opaque+cursor')))
      .mockResolvedValueOnce(response(page([runLoop({ state: 'blocked' }), runLoop({ loopId: 'second', summary: 'Second loop' })])))
      .mockResolvedValueOnce(response({ isOperator: false, page: null }));
    setFetch(fetcher);
    render(<RunsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more runs' }));
    await screen.findByText('Second loop');
    expect(screen.getAllByTestId('run-card')).toHaveLength(2);
    expect(fetcher.mock.calls[1][0]).toBe('/jin/api/runs?cursor=opaque%2Bcursor');
    expect(screen.queryByRole('button', { name: 'Load more runs' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh runs' }));
    await waitFor(() => expect(screen.queryByTestId('runs-lane')).toBeNull());
  });

  it('keeps operator-visible errors recoverable and refresh replaces older loaded cards', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(page()))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response(page([])));
    setFetch(fetcher);
    render(<RunsPanel />);
    await screen.findByText('Runs');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh runs' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getAllByTestId('run-card')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh runs' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh runs' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh runs' }));
    expect(await screen.findByText('No loops recorded.')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([401, 403])('hides already-visible data after an auth failure (%s)', async (status) => {
    setFetch(vi.fn().mockResolvedValueOnce(response(page())).mockResolvedValueOnce(response({}, status)));
    render(<RunsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh runs' }));
    await waitFor(() => expect(screen.queryByTestId('runs-lane')).toBeNull());
  });

  it('navigates to a parent not loaded in the lane and back through descendants', async () => {
    const child = runLoop({ parentLoopId: 'root', summary: 'Child work' });
    const root = runLoop({ loopId: 'root', summary: 'Parent work' });
    setFetch(vi.fn((url: string) => {
      if (url.endsWith('/root')) return Promise.resolve(response(history(root)));
      if (url.endsWith('/loop-1')) return Promise.resolve(response(history(child)));
      if (url.includes('ancestor=root')) return Promise.resolve(response(page([root, child])));
      return Promise.resolve(response(page([child])));
    }));
    render(<RunsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Child work/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Parent: root' }));
    await screen.findByText('Root loop');
    fireEvent.click(screen.getByRole('button', { name: /Child work · warp.run/ }));
    expect(await screen.findByRole('button', { name: 'Parent: root' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Parent: root' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close run history' }));
    expect(screen.queryByTestId('run-detail')).toBeNull();
  });

  it('aborts pending requests when unmounted', async () => {
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetcher);
    const { unmount } = render(<RunsPanel />);
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe('RunsPanelDetail', () => {
  it.each([401, 403])('denies the whole lane on HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, status)));
    const denied = vi.fn();
    render(<RunsPanelDetail loopId="loop-1" onSelect={vi.fn()} onDenied={denied} />);
    await waitFor(() => expect(denied).toHaveBeenCalledOnce());
  });

  it('denies the whole lane on a nonoperator envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ isOperator: false })));
    const denied = vi.fn();
    render(<RunsPanelDetail loopId="loop-1" onSelect={vi.fn()} onDenied={denied} />);
    await waitFor(() => expect(denied).toHaveBeenCalledOnce());
  });

  it.each(['network', 'http'])('reports a %s detail failure without inventing history', async (failure) => {
    const fetcher = vi.fn();
    if (failure === 'network') fetcher.mockRejectedValue(new Error('offline'));
    else fetcher.mockResolvedValue(response({}, 404));
    vi.stubGlobal('fetch', fetcher);
    render(<RunsPanelDetail loopId="missing" onSelect={vi.fn()} onDenied={vi.fn()} />);
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText('History')).toBeNull();
  });

  it('shows honest empty history and aborts pending detail work on unmount', async () => {
    const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(response(url.includes('ancestor=')
      ? page([])
      : { isOperator: true, detail: { loop: runLoop(), events: [] } })));
    vi.stubGlobal('fetch', fetcher);
    const { unmount } = render(<RunsPanelDetail loopId="loop-1" onSelect={vi.fn()} onDenied={vi.fn()} />);
    expect(await screen.findByText('No events recorded.')).toBeDefined();
    const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal | undefined;
    unmount();
    // Every paired fetch shares the same lifecycle, including settled requests.
    expect(signal?.aborted).toBe(true);
  });
});
