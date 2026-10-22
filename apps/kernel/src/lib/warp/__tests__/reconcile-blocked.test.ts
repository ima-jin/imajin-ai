import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { makeAgentRun } from './run-fixture';
import { runLoop } from '@/src/lib/jin/__tests__/runs-fixture';
import { isBlockedLoop } from '@/src/lib/jin/runs-lane';

const { getRun, pr, issue, emit } = vi.hoisted(() => ({
  getRun: vi.fn(), pr: vi.fn(), issue: vi.fn(), emit: vi.fn(),
}));
vi.mock('../dispatch', () => ({
  getAgentRun: getRun,
  isTerminalRunState: (state: string) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state),
}));
vi.mock('../loop-emit', () => ({ emitWarpRunLoopEvent: emit }));
vi.mock('@/src/lib/github/connector', () => ({ getPullRequest: pr, getIssue: issue }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { reconcileWarpBlockers } from '../reconcile-blocked';

const principal = 'did:imajin:operator';
const url = 'https://github.com/ima-jin/imajin-ai/pull/2993';
let clock = Date.parse('2026-10-22T00:00:00Z');
const blocked = () => runLoop({ state: 'blocked', summary: 'cost updated', lastEventType: 'loop.progress' });
const run = (overrides = {}) => makeAgentRun({
  runId: 'loop-1', state: 'BLOCKED',
  statusMessage: { message: 'Waiting on Postal decision\nSecond line', errorCode: null, retryable: null },
  artifacts: [{ artifactType: 'PULL_REQUEST', createdAt: null, data: { url, status: 'merged' } }],
  ...overrides,
});
const reconcile = async (loop = blocked()) => (await reconcileWarpBlockers(principal, [loop]))[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clock += 180_000;
  vi.setSystemTime(clock);
  getRun.mockResolvedValue(run());
  pr.mockResolvedValue({ number: 2993, state: 'open', draft: true });
  issue.mockResolvedValue({ state: 'open' });
  emit.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe('current Warp blocker reconciliation', () => {
  it.each([
    [{ state: 'closed', merged: true }, 'resolved · PR #2993 merged'],
    [{ state: 'closed', merged_at: '2026-10-21' }, 'resolved · PR #2993 merged'],
    [{ state: 'closed' }, 'resolved · PR #2993 closed'],
    [{ state: 'open', draft: false }, 'awaiting review · PR #2993'],
  ])('uses current GitHub facts, not frozen artifact/status text: %j', async (current, summary) => {
    pr.mockResolvedValue({ number: 2993, ...current });
    const result = await reconcile();
    expect(result.summary).toBe(summary);
    expect(isBlockedLoop(result)).toBe(false);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: current.state === 'closed' ? 'loop.finished' : 'loop.progress',
      runId: 'loop-1', principalDid: principal, summary,
    }));
    expect(pr).toHaveBeenCalledWith(principal, 'ima-jin/imajin-ai', 2993);
  });

  it.each([true, false])('keeps draft/no-PR blockers and backfills clobbered historical summaries (PR: %s)', async hasPr => {
    if (!hasPr) getRun.mockResolvedValue(run({ artifacts: [] }));
    const result = await reconcile();
    expect(result.summary).toBe('Waiting on Postal decision');
    expect(isBlockedLoop(result)).toBe(true);
    expect(result.finishedAt).toBeNull();
  });

  it('requires every PR terminal; one held draft dominates merged and ready PRs', async () => {
    getRun.mockResolvedValue(run({ artifacts: [2993, 2973, 2975].map(number => ({
      artifactType: 'PULL_REQUEST', data: { url: `https://github.com/ima-jin/imajin-ai/pull/${number}` },
    })) }));
    pr.mockImplementation(async (_did, _repo, number) => ({
      number, state: number === 2993 ? 'closed' : 'open', draft: number === 2973,
    }));
    expect(isBlockedLoop(await reconcile())).toBe(true);
  });

  it('resolves multiple terminal PRs across repositories with each outcome', async () => {
    getRun.mockResolvedValue(run({ artifacts: [url, 'https://github.com/ima-jin/dykil/pull/28'].map(url => ({
      artifactType: 'PULL_REQUEST', data: { url },
    })) }));
    pr.mockImplementation(async (_did, repo, number) => ({ number, state: 'closed', merged: repo.endsWith('imajin-ai') }));
    expect((await reconcile()).summary).toBe('resolved · PR #2993 merged · PR #28 closed');
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED'])('supersedes no-PR children of terminal %s parents', async state => {
    getRun.mockImplementation(async (_did, id) => id === 'parent' ? makeAgentRun({ state }) : run({ artifacts: [], parentRunId: 'parent' }));
    const result = await reconcile();
    expect(result.state).toBe('superseded');
    expect(isBlockedLoop(result)).toBe(false);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'loop.finished', parentRunId: 'parent' }));
  });

  it('keeps children of active parents held', async () => {
    getRun.mockImplementation(async (_did, id) => id === 'parent' ? makeAgentRun({ state: 'INPROGRESS' }) : run({ artifacts: [], parentRunId: 'parent' }));
    expect(isBlockedLoop(await reconcile())).toBe(true);
  });

  it('resolves a closed linked issue when no PR is held', async () => {
    getRun.mockResolvedValue(run({ artifacts: [], triggerUrl: 'https://github.com/ima-jin/imajin-ai/issues/3011' }));
    issue.mockResolvedValue({ state: 'closed' });
    expect((await reconcile()).summary).toBe('resolved · issue #3011 closed');
  });

  it.each([undefined, 'unknown'])('does not infer readiness from missing/unknown PR fields: %s', async state => {
    pr.mockResolvedValue({ state, draft: false });
    expect(isBlockedLoop(await reconcile())).toBe(true);
  });

  it('does not infer readiness without an explicit draft flag', async () => {
    pr.mockResolvedValue({ number: 2993, state: 'open' });
    expect(isBlockedLoop(await reconcile())).toBe(true);
  });

  it('rejects untrusted URLs rather than sending credentials to an artifact host', async () => {
    getRun.mockResolvedValue(run({ artifacts: [{ artifactType: 'PULL_REQUEST', data: { url: 'https://evil.test/o/r/pull/1' } }] }));
    expect(isBlockedLoop(await reconcile())).toBe(true);
    expect(pr).not.toHaveBeenCalled();
  });

  it.each(['warp', 'github', 'ingest'])('retains signed state when %s authority/read/ingest fails', async boundary => {
    if (boundary === 'warp') getRun.mockRejectedValue(new Error('denied'));
    if (boundary === 'github') pr.mockRejectedValue(new Error('denied'));
    if (boundary === 'ingest') emit.mockResolvedValue(undefined);
    expect(await reconcile()).toEqual(blocked());
  });

  it('does not read or emit for another principal, kind, finished row or active run', async () => {
    const loops = [runLoop({ principal: 'did:imajin:other', state: 'blocked' }), runLoop({ kind: 'pr', state: 'blocked' }),
      runLoop({ state: 'blocked', finishedAt: new Date().toISOString() }), runLoop()];
    expect(await reconcileWarpBlockers(principal, loops)).toEqual(loops);
    expect(getRun).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rechecks within one minute and continues watching review-ready PRs', async () => {
    pr.mockResolvedValue({ number: 2993, state: 'open', draft: false });
    const ready = await reconcile();
    pr.mockResolvedValue({ number: 2993, state: 'closed', merged: true });
    vi.advanceTimersByTime(61_000);
    expect((await reconcile(ready)).state).toBe('resolved');
    expect(pr).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate unchanged observations', async () => {
    const result = await reconcile();
    await reconcile(result);
    expect(pr).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('leaves resumed running segments to their lifecycle watch', async () => {
    getRun.mockResolvedValue(run({ state: 'INPROGRESS' }));
    expect(await reconcile()).toEqual(blocked());
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps the last signed blocker when Warp has no status message', async () => {
    getRun.mockResolvedValue(run({ artifacts: [], statusMessage: null }));
    const loop = blocked();
    loop.summary = 'Operator grant needed\nAdditional context';
    expect((await reconcile(loop)).summary).toBe('Operator grant needed');
  });

  it('uses persisted PR linkage when a later run read omits artifacts', async () => {
    getRun.mockResolvedValue(run({ artifacts: [] }));
    pr.mockResolvedValue({ number: 2993, state: 'closed', merged: true });
    expect((await reconcile(runLoop({ ...blocked(), refs: { pr: url } }))).state).toBe('resolved');
  });

  it('uses persisted parent linkage without superseding PR-backed children', async () => {
    getRun.mockImplementation(async (_did, id) => id === 'parent' ? makeAgentRun() : run({ artifacts: [] }));
    expect((await reconcile(runLoop({ ...blocked(), parentLoopId: 'parent' }))).state).toBe('superseded');
    vi.advanceTimersByTime(61_000);
    getRun.mockResolvedValue(run({ parentRunId: 'parent' }));
    expect((await reconcile()).state).toBe('blocked');
    expect(getRun).toHaveBeenLastCalledWith(principal, 'loop-1');
  });

  it('does not let issue closure hide a held draft PR', async () => {
    getRun.mockResolvedValue(run({ triggerUrl: 'https://github.com/ima-jin/imajin-ai/issues/3011' }));
    issue.mockResolvedValue({ state: 'closed' });
    expect(isBlockedLoop(await reconcile())).toBe(true);
    expect(issue).not.toHaveBeenCalled();
  });

  it('retries failed authority instead of caching a denied read', async () => {
    getRun.mockRejectedValueOnce(new Error('grant revoked'));
    expect(await reconcile()).toEqual(blocked());
    expect((await reconcile()).summary).toBe('Waiting on Postal decision');
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it('scopes cached provider observations to the principal', async () => {
    await reconcile();
    const other = 'did:imajin:other';
    await reconcileWarpBlockers(other, [runLoop({ ...blocked(), principal: other })]);
    expect(getRun).toHaveBeenCalledWith(other, 'loop-1');
    expect(pr).toHaveBeenCalledWith(other, 'ima-jin/imajin-ai', 2993);
  });

  it('uses the same non-PR issue read boundary and retains blockers on denial', async () => {
    getRun.mockResolvedValue(run({ artifacts: [], triggerUrl: 'https://github.com/ima-jin/imajin-ai/issues/3011' }));
    issue.mockRejectedValue(new Error('denied'));
    expect(await reconcile()).toEqual(blocked());
    expect(emit).not.toHaveBeenCalled();
  });

  it('bounds concurrent run reads and preserves page order', async () => {
    let active = 0;
    let maximum = 0;
    getRun.mockImplementation(async (_did, runId) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return run({ runId, artifacts: [] });
    });
    const loops = Array.from({ length: 12 }, (_, index) => runLoop({ ...blocked(), loopId: `batch-${index}` }));
    const result = await reconcileWarpBlockers(principal, loops);
    expect(maximum).toBe(4);
    expect(result.map(loop => loop.loopId)).toEqual(loops.map(loop => loop.loopId));
    expect(await reconcileWarpBlockers(principal, [])).toEqual([]);
  });
});
