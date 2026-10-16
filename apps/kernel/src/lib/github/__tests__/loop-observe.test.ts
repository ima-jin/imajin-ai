import { beforeEach, describe, expect, it, vi } from 'vitest';
const { emit } = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@/src/lib/loops/emit', () => ({ emitKernelLoopEvent: emit }));
import { observePullRequest } from '../loop-observe';
import type { GitHubPullRequest } from '../entities';

const pr: GitHubPullRequest = { number: 1, html_url: 'https://github.com/o/r/pull/1', title: 'PR', state: 'open', body: null, user: null, created_at: '', updated_at: '2026-10-16T00:00:00Z' };
beforeEach(() => vi.clearAllMocks());
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
