// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RunsPanel } from '../runs-panel';
import { RunsPanelDetail } from '../runs-panel-detail';
import { runLoop } from '@/src/lib/jin/__tests__/runs-fixture';

const shared = vi.hoisted(() => ({
  cards: [] as Array<{ proposalId: string; status: string; sessionBinding?: { loopId: string } }>,
  error: null as string | null, row: vi.fn(), notices: vi.fn(), decide: vi.fn(),
}));
vi.mock('../operator-approvals-panel', () => ({
  useRunApprovals: () => ({ approvals: shared.cards, error: shared.error, busyId: '', decisionsLocked: false, handleDecide: shared.decide, handleArchive: vi.fn() }),
  ApprovalCardRow: (props: Record<string, unknown>) => {
    shared.row(props);
    return <p>{(props.approval as { proposalId: string }).proposalId}</p>;
  },
  ApprovalControllerNotices: (props: unknown) => { shared.notices(props); return null; },
}));
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body }) as Response;
const page = (loops = [runLoop()]) => ({ isOperator: true, page: { loops, hasNextPage: false, nextCursor: null } });
const history = (loop = runLoop()) => ({ isOperator: true, detail: { loop, events: [] }, commandTarget: { available: true, agentDid: 'did:agent' } });

afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.useRealTimers();
  shared.cards = []; shared.error = null; shared.row.mockClear(); shared.notices.mockClear();
});

describe('interactive Runs integration', () => {
  it('unifies blockers with all pending shared cards, keeps unbound cards honest and exposes shared notices', async () => {
    shared.cards = [
      { proposalId: 'bound', status: 'pending', sessionBinding: { loopId: 'loop-1' } },
      { proposalId: 'unbound', status: 'pending' }, { proposalId: 'done', status: 'applied' },
    ];
    shared.error = 'Approvals refresh unavailable';
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url === '/api/loops/surfaces'
      ? { conflicts: [] } : page([runLoop({ state: 'blocked' })])))));
    render(<RunsPanel />);
    const unified = await screen.findByTestId('blocked-on-you');
    expect(unified.textContent).toContain('Needs attention');
    expect(unified.textContent).toContain('Bound to loop loop-1');
    expect(unified.textContent).toContain('No verified loop binding');
    expect(unified.textContent).toContain('Approvals refresh unavailable');
    expect(unified.textContent).not.toContain('done');
    expect(shared.row.mock.calls.every(([props]) => props.anchor === false && props.onDecide === shared.decide)).toBe(true);
    expect(shared.notices.mock.lastCall?.[0].controller.handleDecide).toBe(shared.decide);
  });

  it('shows conflict details on both threads without stopping either and retains phone-safe layout', async () => {
    const conflict = { id: 'conflict', loopId: 'a', type: 'surface.conflicted', payload: {
      loopId: 'a', refs: { conflictingLoopId: 'b' }, surface: 'issue:#2404',
    } };
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url === '/api/loops/surfaces'
      ? { conflicts: [conflict] } : page([runLoop({ loopId: 'a' }), runLoop({ loopId: 'b' })])))));
    const { container } = render(<RunsPanel />);
    await waitFor(() => expect(screen.getAllByText('Surface conflict · warning only')).toHaveLength(2));
    for (const card of screen.getAllByTestId('run-card')) {
      expect(card.textContent).toContain('issue:#2404');
      expect(card.textContent).toContain('neither thread is stopped');
      expect(card.className).toContain('min-w-0');
    }
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });

  it('keeps typed drafts through polling, disables stale availability on failure, then recovers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failed = false;
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(failed ? {} : url.includes('ancestor=')
      ? page([]) : history(), failed ? 500 : 200))));
    render(<RunsPanelDetail loopId="loop-1" onSelect={vi.fn()} onDenied={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'keep draft' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('keep draft');
    failed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign & stop' }).hasAttribute('disabled')).toBe(true);
    failed = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('keep draft');
  });

  it('never applies another loop response after selection changes or overlaps poll requests', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolveOld: (value: Response) => void = () => {};
    const old = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetcher = vi.fn((url: string) => url.endsWith('/old') ? old : Promise.resolve(response(url.includes('ancestor=')
      ? page([]) : history(runLoop({ loopId: 'new', summary: 'New loop' })))));
    vi.stubGlobal('fetch', fetcher);
    const denied = vi.fn();
    const view = render(<RunsPanelDetail loopId="old" onSelect={vi.fn()} onDenied={denied} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    view.rerender(<RunsPanelDetail loopId="new" onSelect={vi.fn()} onDenied={denied} />);
    await screen.findByTestId('run-detail');
    await act(async () => { resolveOld(response(history(runLoop({ loopId: 'old' })))); });
    expect(screen.getByTestId('run-detail').textContent).toContain('new');
    expect(screen.getByTestId('run-detail').textContent).not.toContain('old');
  });

  it('revokes the lane on scoped surface authorization failure', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url === '/api/loops/surfaces'
      ? response({}, 403) : response(page()))));
    render(<RunsPanel />);
    await waitFor(() => expect(screen.queryByTestId('runs-lane')).toBeNull());
  });

  it('renders a verified bound shared row inline under its thread with the exact same controller', async () => {
    shared.cards = [{ proposalId: 'bound', status: 'pending', sessionBinding: { loopId: 'loop-1' } }];
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url === '/api/loops/surfaces'
      ? { conflicts: [] } : url.endsWith('/loop-1') ? history() : page()))));
    render(<RunsPanel />);
    const card = (await screen.findAllByTestId('run-card'))[0];
    fireEvent.click(within(card).getByRole('button'));
    expect(await within(card).findByText('bound')).toBeDefined();
    expect(within(screen.getByTestId('blocked-on-you')).getByText('bound')).toBeDefined();
    expect(shared.row.mock.calls.every(([props]) => props.onDecide === shared.decide && props.anchor === false)).toBe(true);
    expect(screen.getByRole('heading', { name: 'Threads' })).toBeDefined();
  });

  it('silently merges an attested child into the main tree without losing loaded pages, cursor or draft', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let updated = false;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/loops/surfaces') return Promise.resolve(response({ conflicts: [] }));
      if (url.endsWith('/loop-1')) return Promise.resolve(response(history()));
      if (url.includes('ancestor=')) return Promise.resolve(response(page()));
      if (url.includes('cursor=')) return Promise.resolve(response({ ...page([runLoop({ loopId: 'older', summary: 'Older loaded page' })]), page: {
        loops: [runLoop({ loopId: 'older', summary: 'Older loaded page' })], nextCursor: 'second-page', hasNextPage: true,
      } }));
      const loops = [runLoop(), ...(updated ? [runLoop({ loopId: 'child', parentLoopId: 'loop-1', kind: 'openclaw.subagent', summary: 'Attested child' })] : [])];
      return Promise.resolve(response({ ...page(loops), page: { loops, nextCursor: updated ? null : 'first-page', hasNextPage: !updated } }));
    }));
    render(<RunsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more runs' }));
    await screen.findByText('Older loaded page');
    const parent = screen.getAllByTestId('run-card').find((card) => card.textContent?.includes('Implement registry'))!;
    fireEvent.click(within(parent).getByRole('button'));
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'keep through tree refresh' } });
    updated = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getAllByTestId('run-card')).toHaveLength(3);
    expect(screen.getByText('Older loaded page')).toBeDefined();
    expect(screen.getByText('Attested child')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Load more runs' })).toBeDefined();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('keep through tree refresh');
  });
});
