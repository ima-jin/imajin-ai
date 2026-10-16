import { beforeEach, describe, expect, it, vi } from 'vitest';
const { emit, sql } = vi.hoisted(() => ({ emit: vi.fn(), sql: vi.fn() }));
vi.mock('@/src/lib/loops/emit', () => ({ emitKernelLoopEvent: emit }));
vi.mock('@imajin/db', () => ({ getClient: () => sql }));
import { observePullRequest, observeWarpPullRequestArtifact } from '../loop-observe';
import type { GitHubPullRequest } from '../entities';

const pr: GitHubPullRequest = { number: 1, html_url: 'https://github.com/o/r/pull/1', title: 'PR', state: 'open', body: null, user: null, created_at: '', updated_at: '2026-10-16T00:00:00Z' };
beforeEach(() => {
  vi.clearAllMocks();
  sql.mockReset().mockResolvedValue([]);
});

describe('first Warp PR artifact observation', () => {
  it('creates an insert-only PR loop with confirmed run lineage and shared provider observation id', async () => {
    await observeWarpPullRequestArtifact('did:imajin:owner', pr.html_url, 'run', '2026-10-16T00:00:00Z');
    expect(emit).toHaveBeenCalledWith('loop.started', expect.objectContaining({
      kind: 'pr', principal: 'did:imajin:owner', refs: { pr: pr.html_url }, parentLoopId: 'run',
      state: 'artifact-observed', initialObservation: true, source: 'warp.PULL_REQUEST',
    }));
    const artifactLoopId = emit.mock.calls[0][1].loopId;
    const [strings, ...values] = sql.mock.calls[0];
    expect(strings.join('?')).toContain('WHERE loop_id = ? AND principal = ?');
    expect(values).toEqual([artifactLoopId, 'did:imajin:owner']);
    await observePullRequest('did:imajin:owner', { ...pr, state: 'closed' });
    expect(emit.mock.calls[1][1].loopId).toBe(artifactLoopId);
  });
  it.each(['open', 'closed', 'merged', 'artifact-observed'])('never overwrites a known principal-specific PR loop (%s)', async (state) => {
    sql.mockResolvedValueOnce([{ loop_id: 'existing', state }]);
    await observeWarpPullRequestArtifact('did:imajin:owner', pr.html_url, 'other-run', '2026-10-16T00:00:00Z');
    expect(emit).not.toHaveBeenCalled();
  });
  it('does not accept invalid artifact refs or invent a principal', async () => {
    await observeWarpPullRequestArtifact('system', pr.html_url, 'run', '2026-10-16T00:00:00Z');
    await observeWarpPullRequestArtifact('did:imajin:owner', 'https://not-github.example/o/r/pull/1', 'run', '2026-10-16T00:00:00Z');
    expect(emit).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });
});
describe('explicit GitHub PR observations', () => {
  it.each([
    [{ state: 'open' }, 'loop.started', 'open'],
    [{ state: 'open', draft: true }, 'loop.started', 'draft'],
    [{ state: 'closed' }, 'loop.finished', 'closed'],
    [{ state: 'closed', merged: true }, 'loop.finished', 'merged'],
    [{ state: 'closed', merged_at: '2026-10-16T00:00:00Z' }, 'loop.finished', 'merged'],
  ])('publishes only known state %s', async (fields, type, state) => {
    await observePullRequest('did:imajin:owner', { ...pr, ...fields } as GitHubPullRequest);
    expect(emit).toHaveBeenCalledWith(type, expect.objectContaining({
      kind: 'pr', principal: 'did:imajin:owner', refs: { pr: pr.html_url }, state, source: 'github.getPullRequest', providerUpdatedAt: pr.updated_at,
    }));
  });
  it('does not infer a state or accept a non-GitHub ref/non-DID principal', async () => {
    await observePullRequest('did:imajin:owner', { ...pr, state: 'unknown' });
    await observePullRequest('did:imajin:owner', { ...pr, html_url: 'https://elsewhere.test/pull/1' });
    await observePullRequest('system', pr);
    expect(emit).not.toHaveBeenCalled();
  });
});
