// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { Horizon, HorizonStep } from '@/src/lib/loops/horizon';
import type { SessionCommandFrame } from '@/src/lib/jin/session-command-contract';
import { sessionCommandBody } from '@/src/lib/jin/session-command-contract';
import { RunsHorizon } from '../runs-horizon';
import { useRunsHorizon } from '../use-runs-horizon';
import { canonicalCommandJson, type SessionCommandClient } from '../session-command-client';

const now = Date.parse('2026-10-18T12:00:00Z');
const denied = vi.fn();
const select = vi.fn();
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
}) as Response;

function step(stepId: string, zone: HorizonStep['zone'], rank = 1): HorizonStep {
  return {
    stepId, publisher: 'did:imajin:publisher', zone, rank, stepKind: 'human', intention: `Intention ${stepId}`, state: 'queued',
    exitConditions: [{ id: 'human', kind: 'attestation', attestorDid: 'did:human:reviewer' }],
    conditions: [], openExitConditions: ['human'],
  };
}

function envelope(steps: HorizonStep[] = [], available = true, depth = steps.length) {
  return { isOperator: true, lastStepEventAt: '2026-10-18T12:00:00.000Z',
    detail: { horizon: { steps, depth, targetDepth: 12 } satisfies Horizon },
    commandTarget: { available } };
}

function fixture(steps: HorizonStep[], available = true, depth = steps.length) {
  const fetcher = vi.fn().mockResolvedValue(response(envelope(steps, available, depth)));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function mount(loopIds = ['loop-1'], client?: SessionCommandClient, hasMore = false) {
  return render(<RunsHorizon loopIds={loopIds} onDenied={denied} onSelect={select} client={client} hasMore={hasMore} />);
}

async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  denied.mockClear();
  select.mockClear();
});

describe('Runs horizon observations', () => {
  it('renders each step’s publisher as plain text, never a DID link or HTML', async () => {
    const first = { ...step('first', 'tail'), publisher: 'did:imajin:first' };
    const second = { ...step('second', 'near'), publisher: 'did:imajin:<b>second</b>' };
    fixture([first, second]);
    mount();
    await screen.findByText('Intention first');
    const rows = screen.getAllByTestId('horizon-step');
    for (const item of [first, second]) {
      const row = rows.find(row => within(row).queryByText(`Intention ${item.stepId}`));
      expect(row).toBeDefined();
      const attribution = within(row!).getByText(`Publisher · ${item.publisher}`);
      expect(attribution.textContent).toBe(`Publisher · ${item.publisher}`);
      expect(attribution.getAttribute('title')).toBe(item.publisher);
      expect(attribution.closest('a')).toBeNull();
      expect(attribution.children).toHaveLength(0);
    }
  });
  it('renders all zones in nearest-first order, ranks within zones and hides exited steps', async () => {
    fixture([
      step('tail', 'tail', 0), step('middle-later', 'middle', 9),
      { ...step('middle-first', 'middle', 2), issue: { ref: 'org/repo#2880', outcome: 'OUTCOME preserve the signed facts' } },
      step('near', 'near'), step('head', 'head'), step('past', 'past'), step('done', 'done'),
    ]);
    const { container } = mount(['loop-1'], undefined, true);
    await screen.findByText('org/repo#2880');
    const horizon = screen.getByRole('region', { name: 'Runs horizon' });
    expect(within(horizon).getAllByRole('region').map(region => region.getAttribute('aria-label')))
      .toEqual(['head steps', 'near steps', 'middle steps', 'tail steps', 'past steps']);
    expect(within(screen.getByRole('region', { name: 'middle steps' })).getAllByTestId('horizon-step')
      .map(item => item.textContent)).toEqual([
      expect.stringContaining('org/repo#2880OUTCOME preserve the signed facts'),
      expect.stringContaining('Intention middle-later'),
    ]);
    expect(screen.queryByText('Intention done')).toBeNull();
    expect(screen.getAllByTestId('horizon-step')).toHaveLength(6);
    expect(screen.getByText(/Loaded runs only/)).toBeDefined();
    expect(container.querySelector('table')).toBeNull();
    for (const item of screen.getAllByTestId('horizon-step')) expect(item.className).toContain('min-w-0');
  });

  it('shows one unpublished line with never, no zones or below-target even with no loops', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ isOperator: true, lastStepEventAt: null }));
    vi.stubGlobal('fetch', fetcher);
    const { container } = mount([]);
    await screen.findByText("No horizon steps published yet · the harness horizon sync (#2881) hasn't reported · last step never");
    expect(screen.getByLabelText('Horizon depth').textContent).toBe('0 / 12');
    expect(within(screen.getByRole('region', { name: 'Runs horizon' })).queryAllByRole('region')).toHaveLength(0);
    expect(screen.queryByText(/Below target/)).toBeNull();
    expect(screen.queryByText(/Horizon drained/)).toBeNull();
    expect(container.querySelector('time')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/jin/api/runs/horizon-status', {
      credentials: 'include', cache: 'no-store', signal: expect.any(AbortSignal),
    });
  });

  it.each([{ steps: [] }, { steps: [step('exited', 'done')] }])('shows drained with the last event and depth, whether done steps are omitted or included (%j)', async ({ steps }) => {
    fixture(steps, true, 0);
    mount();
    await screen.findByText(/Horizon drained · last step/);
    expect(screen.getByText('2026-10-18T12:00:00.000Z').getAttribute('datetime')).toBe('2026-10-18T12:00:00.000Z');
    expect(screen.getByLabelText('Horizon depth').textContent).toBe('0 / 12');
    expect(screen.queryByText(/No horizon steps published yet/)).toBeNull();
    expect(screen.queryByText(/Below target/)).toBeNull();
    expect(screen.queryAllByTestId('horizon-step')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'tail steps' })).toBeNull();
  });

  it('does not declare the whole horizon drained while older runs are unloaded', async () => {
    fixture([]);
    mount(['loop-1'], undefined, true);
    await screen.findByText(/No horizon steps in loaded runs · last step/);
    expect(screen.queryByText(/Horizon drained/)).toBeNull();
    expect(screen.getByText(/Loaded runs only/)).toBeDefined();
  });

  it('keeps active projections visible even if publication status races with a new step', async () => {
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/horizon-status')
      ? { isOperator: true, lastStepEventAt: null } : envelope([step('new', 'tail')]))));
    vi.stubGlobal('fetch', fetcher);
    mount();
    await screen.findByText('Intention new');
    expect(screen.getByText(/Below target/)).toBeDefined();
    expect(screen.queryByText(/No horizon steps published yet/)).toBeNull();
    expect(screen.queryByText(/Horizon drained/)).toBeNull();
  });

  it('does not infer unpublished or drained while loading or when the status read fails', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise));
    mount([]);
    expect(screen.getByText('Loading horizon…')).toBeDefined();
    expect(screen.queryByText(/No horizon steps published yet|Horizon drained|Below target/)).toBeNull();
    await act(async () => { pending.resolve(response({}, 500)); });
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByText(/No horizon steps published yet|Horizon drained|Below target/)).toBeNull();
  });

  it('keeps ref-only legacy facts honest, uses tail intentions and opens the exact encoded loop', async () => {
    const refOnly = { ...step('legacy', 'middle'), issue: { ref: 'org/repo#77' } } as HorizonStep;
    fixture([refOnly, { ...step('fuzzy', 'tail'), issue: { ref: 'hidden-ref', outcome: 'OUTCOME hidden tail detail' } }]);
    mount(['loop/a']);
    await screen.findByText('org/repo#77');
    expect(screen.queryByText(/OUTCOME/)).toBeNull();
    expect(screen.queryByText('hidden-ref')).toBeNull();
    expect(screen.getByText('Intention fuzzy')).toBeDefined();
    const link = screen.getAllByRole('link', { name: 'Live loop · loop/a' })[0];
    expect(link.getAttribute('href')).toBe('#run-loop%2Fa');
    fireEvent.click(link);
    expect(select).toHaveBeenCalledWith('loop/a');
  });

  it.each([0, 5, 12, 15])('reports observed depth %s without filling or capping it', async depth => {
    fixture(depth ? [step('visible', 'tail')] : [], true, depth);
    mount();
    await waitFor(() => expect(screen.queryByText('Loading horizon…')).toBeNull());
    expect(screen.getByLabelText('Horizon depth').textContent).toBe(`${depth} / 12`);
    if (depth > 0 && depth < 12) expect(screen.getByText(`Below target · ${12 - depth} more steps to reach 12. The horizon is not full yet.`)).toBeDefined();
    else expect(screen.queryByText(/Below target/)).toBeNull();
    expect(screen.queryAllByTestId('horizon-step')).toHaveLength(depth ? 1 : 0);
  });

  it.each([
    [new Date(now + 60_000).toISOString(), 'less than 1m'],
    [new Date(now - 30_000).toISOString(), 'less than 1m'],
    [new Date(now - 59 * 60_000).toISOString(), '59m'],
    [new Date(now - 125 * 60_000).toISOString(), '2h 5m'],
    ['invalid-date', 'age unknown'],
  ])('renders lease acquisition %s as %s', async (acquiredAt, age) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    fixture([{ ...step('held', 'head'), claim: {
      leaseId: 'lease-1', acquiredAt, holderDid: 'did:agent:holder', expiresAt: '2026-10-18T13:00:00Z',
    } }]);
    mount();
    await screen.findByText('Holder · did:agent:holder');
    expect(screen.getByText(age).getAttribute('datetime')).toBe(acquiredAt);
    expect(screen.getByText('2026-10-18T13:00:00Z').getAttribute('datetime')).toBe('2026-10-18T13:00:00Z');
  });

  it('shows release evidence and every open exit condition without declaring deployment', async () => {
    const past = step('closed', 'past');
    past.conditions = [
      { declaration: { id: 'issue', kind: 'issue_closed' }, satisfied: false, evidence: null },
      { declaration: { id: 'release-open', kind: 'release_contains' }, satisfied: false, evidence: null },
      { declaration: { id: 'prod', kind: 'deployed' }, satisfied: false, evidence: null },
      { declaration: { id: 'human', kind: 'attestation', attestorDid: 'did:human:reviewer' }, satisfied: false, evidence: null },
      { declaration: { id: 'release', kind: 'release_contains' }, satisfied: true, evidence: {
        eventId: 'signed-release', issuer: 'did:release:bot', at: '2026-10-18T11:00:00Z',
        fact: { kind: 'release_contains', repository: 'org/repo', issue: 'org/repo#2880', mergeCommit: 'a'.repeat(40), tag: 'v0.9.0' },
      } },
    ];
    past.openExitConditions = ['issue', 'release-open', 'prod', 'human', 'legacy-condition'];
    fixture([past, step('no-evidence', 'past')]);
    mount();
    await screen.findByText('In v0.9.0');
    for (const label of ['issue not closed', 'not in a release', 'not on prod', 'awaiting attestation · did:human:reviewer', 'legacy-condition']) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.getAllByText('In v0.9.0')).toHaveLength(1);
    expect(screen.queryByText('Deployed')).toBeNull();
  });

  it('aggregates multiple loops and breaks equal ranks by loop then step ID', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url.endsWith('/a')
      ? envelope([step('z', 'near'), step('a', 'near')], true, 4)
      : envelope([step('b', 'near')], true, 9)))));
    mount(['z', 'a']);
    await screen.findByText('Intention b');
    expect(screen.getByLabelText('Horizon depth').textContent).toBe('13 / 12');
    expect(screen.getAllByTestId('horizon-step').map(item => item.textContent)).toEqual([
      expect.stringContaining('Intention a'), expect.stringContaining('Intention z'), expect.stringContaining('Intention b'),
    ]);
  });

  it('moves only with polled projection near → head → past → gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = fixture([step('moving', 'near')]);
    mount();
    await screen.findByText('Intention moving');
    for (const zone of ['head', 'past'] as const) {
      fetcher.mockResolvedValue(response(envelope([step('moving', zone)])));
      await poll();
      expect(within(screen.getByRole('region', { name: `${zone} steps` })).getByText('Intention moving')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Sign & claim moving' })).toBeNull();
    }
    fetcher.mockResolvedValue(response(envelope([])));
    await poll();
    expect(screen.queryByText('Intention moving')).toBeNull();
    expect(screen.getByLabelText('Horizon depth').textContent).toBe('0 / 12');
  });
});

describe('Signed horizon claim requests', () => {
  it.each([true, false])('prepares and dispatches a real signed session.send without optimistic head (delivered=%s)', async delivered => {
    vi.stubGlobal('crypto', webcrypto);
    const ed = await import('@noble/ed25519');
    const privateKey = '12'.repeat(32);
    const publicBytes = await ed.getPublicKeyAsync(Uint8Array.from(privateKey.match(/../g)!, part => Number.parseInt(part, 16)));
    const publicKey = Array.from(publicBytes, byte => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey, publicKey }));
    const loopId = 'loop/"quoted"';
    const stepId = 'step "quoted"';
    const requests: Array<{ action: string; type?: string; payload?: Record<string, string>; command?: SessionCommandFrame }> = [];
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      if (!url.endsWith('/commands')) return Promise.resolve(response(envelope([step(stepId, 'near')])));
      expect(url).toBe(`/jin/api/runs/${encodeURIComponent(loopId)}/commands`);
      expect(options?.credentials).toBe('include');
      const body = JSON.parse(options?.body as string);
      requests.push(body);
      if (body.action === 'dispatch') return pending.promise;
      return Promise.resolve(response({ command: {
        type: body.type, payload: body.payload, commandId: 'claim-1', to: 'did:agent:serving',
        principal: 'did:human:operator', issuer: 'did:node:kernel',
        issuedAt: '2026-10-18T12:00:00Z', expiresAt: '2026-10-18T12:01:00Z',
        signature: { keyId: 'ab'.repeat(32), alg: 'ed25519', sig: 'cd'.repeat(64) },
      } }));
    }));
    mount([loopId]);
    const button = await screen.findByRole('button', { name: `Sign & claim ${stepId}` });
    fireEvent.click(button);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.textContent).toBe('Signing claim…');
    expect(requests[0]).toEqual({ action: 'prepare', type: 'session.send', payload: {
      loopId, message: `Claim horizon step ${JSON.stringify(stepId)} in loop ${JSON.stringify(loopId)}. Acquire its step lease through the signed loop rail; do not treat this request as an acquired lease.`,
    } });
    const command = requests[1].command!;
    expect(command.payload).toEqual(requests[0].payload);
    expect(command.countersignature).toEqual({ keyId: publicKey, alg: 'ed25519', sig: expect.stringMatching(/^[a-f0-9]{128}$/) });
    const sig = Uint8Array.from(command.countersignature!.sig.match(/../g)!, part => Number.parseInt(part, 16));
    expect(await ed.verifyAsync(sig, new TextEncoder().encode(canonicalCommandJson(sessionCommandBody(command))), publicBytes)).toBe(true);
    await act(async () => { pending.resolve(response({ commandId: 'claim-1', delivered })); });
    expect(await screen.findByText(delivered
      ? 'Claim request delivered · awaiting projected lease'
      : 'Claim request recorded but undelivered · no lease confirmed')).toBeDefined();
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(within(screen.getByRole('region', { name: 'head steps' })).queryByTestId('horizon-step')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'near steps' })).getByTestId('horizon-step')).toBeDefined();
  });

  it('reports a missing browser key without sending a command or confirming a lease', async () => {
    const fetcher = fixture([step('ready', 'near')]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign & claim ready' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A signing key is required in this browser.');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Sign & claim ready' }).hasAttribute('disabled')).toBe(false);
  });

  it.each([new Error('Serving agent unavailable'), 'unknown rejection'])('reports claim failure and allows retry (%s)', async failure => {
    fixture([step('ready', 'near')]);
    const client = { prepare: vi.fn().mockRejectedValue(failure), dispatch: vi.fn() };
    mount(['loop-1'], client);
    const button = await screen.findByRole('button', { name: 'Sign & claim ready' });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe(failure instanceof Error ? failure.message : 'Claim request unavailable. No lease confirmed.');
    expect(client.dispatch).not.toHaveBeenCalled();
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('disables claims with no verified command target', async () => {
    fixture([step('ready', 'near')], false);
    const client = { prepare: vi.fn(), dispatch: vi.fn() };
    mount(['loop-1'], client);
    const button = await screen.findByRole('button', { name: 'Sign & claim ready' });
    fireEvent.click(button);
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/fresh projection and verified serving agent/)).toBeDefined();
    expect(client.prepare).not.toHaveBeenCalled();
  });

  it.each(['network', 'http'])('retains last observation but disables claims on %s failure and recovers', async failure => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = fixture([step('ready', 'near')]);
    mount();
    const button = await screen.findByRole('button', { name: 'Sign & claim ready' });
    if (failure === 'network') fetcher.mockRejectedValue(new Error('offline'));
    else fetcher.mockResolvedValue(response({}, 500));
    await poll();
    expect(screen.getByRole('alert').textContent).toContain('Showing last observation; claims disabled.');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Intention ready')).toBeDefined();
    fetcher.mockResolvedValue(response(envelope([step('ready', 'near')])));
    await poll();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button.hasAttribute('disabled')).toBe(false);
  });
});

describe('Horizon polling lifecycle', () => {
  it.each([undefined, 'not-a-date', 7])('rejects incomplete status %s without publishing partial projections', async lastStepEventAt => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url.endsWith('/horizon-status')
      ? { isOperator: true, lastStepEventAt } : envelope([step('unconfirmed', 'near')])))));
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByText('Intention unconfirmed')).toBeNull();
    expect(screen.queryByText(/No horizon steps published yet|Horizon drained|Below target/)).toBeNull();
  });

  it.each([401, 403, 'nonoperator', 500, 'network'])('keeps status failure %s separate from no producer and recovers', async status => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failed = false;
    const fetcher = vi.fn((url: string) => {
      if (!url.endsWith('/horizon-status')) return Promise.resolve(response(envelope([step('ready', 'near')])));
      if (failed && status === 'network') return Promise.reject(new Error('offline'));
      if (failed) return Promise.resolve(status === 'nonoperator' ? response({ isOperator: false }) : response({}, Number(status)));
      return Promise.resolve(response({ isOperator: true, lastStepEventAt: '2026-10-18T08:00:00-04:00' }));
    });
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => useRunsHorizon(['first'], denied));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.lastStepEventAt).toBe('2026-10-18T12:00:00.000Z');
    failed = true;
    await poll();
    expect(hook.result.current.error).toContain('claims disabled');
    expect(hook.result.current.runs[0].horizon.depth).toBe(1);
    expect(hook.result.current.lastStepEventAt).toBe('2026-10-18T12:00:00.000Z');
    expect(denied).toHaveBeenCalledTimes(status === 401 || status === 403 || status === 'nonoperator' ? 1 : 0);
    failed = false;
    await poll();
    expect(hook.result.current.error).toBe('');
  });

  it('polls unpublished → active → drained without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let steps: HorizonStep[] = [];
    let lastStepEventAt: string | null = null;
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url.endsWith('/horizon-status')
      ? { isOperator: true, lastStepEventAt } : envelope(steps)))));
    mount();
    await screen.findByText(/No horizon steps published yet/);
    steps = [step('published', 'tail')];
    lastStepEventAt = '2026-10-18T12:00:00.000Z';
    await poll();
    expect(screen.getByText('Intention published')).toBeDefined();
    expect(screen.queryByText(/No horizon steps published yet/)).toBeNull();
    steps = [];
    await poll();
    expect(screen.getByText(/Horizon drained · last step/)).toBeDefined();
    expect(screen.queryByText(/Below target/)).toBeNull();
  });

  it.each(['success', 'denied', 'failure'])('aborts a pending status read and ignores late %s', async outcome => {
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => useRunsHorizon([], denied));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    hook.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(outcome === 'success' ? response({ isOperator: true, lastStepEventAt: null })
      : response({}, outcome === 'denied' ? 403 : 500)); });
    expect(denied).not.toHaveBeenCalled();
  });
  it.each([401, 403, 'nonoperator'])('notifies the owner when authorization is revoked (%s)', async status => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = fixture([step('sensitive', 'near')]);
    mount();
    await screen.findByText('Intention sensitive');
    fetcher.mockResolvedValue(status === 'nonoperator' ? response({ isOperator: false }) : response({}, status));
    await poll();
    expect(denied).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Sign & claim sensitive' }).hasAttribute('disabled')).toBe(true);
  });

  it('reads status even for an empty selection and reports absent horizons as unavailable', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ isOperator: true, detail: {}, lastStepEventAt: null }));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(({ ids }) => useRunsHorizon(ids, denied), { initialProps: { ids: [] as string[] } });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hook.result.current.lastStepEventAt).toBeNull();
    hook.rerender({ ids: ['legacy'] });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.runs).toEqual([]);
    expect(hook.result.current.error).toContain('claims disabled');
  });

  it.each([
    undefined, {}, { steps: {}, depth: 1, targetDepth: 12 }, { steps: [], depth: -1, targetDepth: 12 },
    { steps: [], depth: 1.5, targetDepth: 12 }, { steps: [], depth: 0, targetDepth: 10 },
  ])('retains the complete last observation on an incomplete projection (%s)', async horizon => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = fixture([step('ready', 'near')]);
    mount();
    await screen.findByText('Intention ready');
    fetcher.mockResolvedValue(response({ isOperator: true, detail: { horizon } }));
    await poll();
    expect(screen.getByRole('alert').textContent).toContain('claims disabled');
    expect(screen.getByLabelText('Horizon depth').textContent).toBe('1 / 12');
    expect(screen.getByRole('button', { name: 'Sign & claim ready' }).hasAttribute('disabled')).toBe(true);
  });

  it('bounds batches to six, prevents overlapping polls and aborts on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const ids = Array.from({ length: 8 }, (_, index) => `loop-${index}`);
    const hook = renderHook(() => useRunsHorizon(ids, denied));
    expect(fetcher).toHaveBeenCalledTimes(6);
    await poll();
    expect(fetcher).toHaveBeenCalledTimes(6);
    await act(async () => { pending.resolve(response(envelope())); });
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(hook.result.current.runs.map(run => run.loopId)).toEqual(ids);
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    expect(fetcher.mock.calls[0]).toEqual(['/jin/api/runs/loop-0', {
      signal, credentials: 'include', cache: 'no-store',
    }]);
    hook.unmount();
    expect(signal.aborted).toBe(true);
    await poll();
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it('does not start the next batch after unmount while the first batch is pending', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const ids = Array.from({ length: 8 }, (_, index) => `loop-${index}`);
    const hook = renderHook(() => useRunsHorizon(ids, denied));
    expect(fetcher).toHaveBeenCalledTimes(6);
    hook.unmount();
    await act(async () => { pending.resolve(response(envelope())); });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(denied).not.toHaveBeenCalled();
  });

  it('waits for every sibling read to settle after one fails before allowing the next poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = deferred<Response>();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(response(envelope()));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => useRunsHorizon(['first', 'second'], denied));
    await act(async () => { await Promise.resolve(); });
    await poll();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve(response(envelope())); });
    expect(hook.result.current.error).toContain('claims disabled');
    expect(hook.result.current.loading).toBe(false);
    await poll();
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(hook.result.current.error).toBe('');
    expect(hook.result.current.runs.map(run => run.loopId)).toEqual(['first', 'second']);
  });

  it('disables every loop claim after a single loop read fails and recovers atomically', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failFirst = false;
    const fetcher = vi.fn((url: string) => Promise.resolve(failFirst && url.endsWith('/first')
      ? response({}, 500) : response(envelope([step(url.endsWith('/first') ? 'first-step' : 'second-step', 'near')]))));
    vi.stubGlobal('fetch', fetcher);
    mount(['first', 'second']);
    await screen.findByText('Intention second-step');
    failFirst = true;
    await poll();
    expect(screen.getByRole('alert')).toBeDefined();
    for (const button of screen.getAllByRole('button', { name: /Sign & claim/ })) {
      expect(button.hasAttribute('disabled')).toBe(true);
    }
    expect(screen.getAllByTestId('horizon-step')).toHaveLength(2);
    failFirst = false;
    await poll();
    expect(screen.queryByRole('alert')).toBeNull();
    for (const button of screen.getAllByRole('button', { name: /Sign & claim/ })) {
      expect(button.hasAttribute('disabled')).toBe(false);
    }
  });

  it.each(['success', 'denied', 'failure'])('ignores late %s after selection key changes and preserves stable keys', async outcome => {
    const pending = deferred<Response>();
    const fetcher = vi.fn((url: string, _options?: RequestInit) => url.endsWith('/old') ? pending.promise
      : Promise.resolve(response(envelope([step('new-step', 'tail')]))));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(({ ids }) => useRunsHorizon(ids, denied), { initialProps: { ids: ['old'] } });
    const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
    hook.rerender({ ids: ['old'] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    hook.rerender({ ids: ['new/selected'] });
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(hook.result.current.runs[0]?.loopId).toBe('new/selected'));
    expect(fetcher.mock.calls[1][0]).toBe('/jin/api/runs/new%2Fselected');
    await act(async () => {
      pending.resolve(outcome === 'success' ? response(envelope([step('old-step', 'head')]))
        : response({}, outcome === 'denied' ? 403 : 500));
    });
    expect(hook.result.current.runs[0].horizon.steps[0].stepId).toBe('new-step');
    expect(hook.result.current.error).toBe('');
    expect(denied).not.toHaveBeenCalled();
  });

  it('aborts pending work on unmount and ignores its late nonoperator response', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => useRunsHorizon(['pending'], denied));
    expect(hook.result.current.loading).toBe(true);
    hook.unmount();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(response({ isOperator: false })); });
    expect(denied).not.toHaveBeenCalled();
  });
});
