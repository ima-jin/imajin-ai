import { emitKernelLoopEvent } from '@/src/lib/loops/emit';
import { githubLoopRef } from '@/src/lib/warp/loop-refs';
import type { GitHubPullRequest } from './entities';

function prLoopId(principal: string, ref: string): string {
  return `pr:${principal}:${ref}`;
}

/** Record first provider-typed artifact appearance, never overwrite known state. */
export async function observeWarpPullRequestArtifact(principal: string, url: string, runId: string, at: string): Promise<void> {
  const ref = githubLoopRef(url, 'pull');
  if (!ref || !principal.startsWith('did:') || principal.length <= 4) return;
  const loopId = prLoopId(principal, ref);
  const { getClient } = await import('@imajin/db');
  const sql = getClient();
  const existing = await sql`
    SELECT loop_id FROM kernel.loops
    WHERE loop_id = ${loopId} AND principal = ${principal}
    LIMIT 1
  `;
  if (existing.length > 0) return;
  await emitKernelLoopEvent('loop.started', {
    loopId,
    kind: 'pr',
    principal,
    parentLoopId: runId,
    refs: { pr: ref },
    state: 'artifact-observed',
    summary: 'GitHub pull request artifact observed in Warp run',
    at,
    source: 'warp.PULL_REQUEST',
    // The projection also enforces insert-only behavior, closing the race
    // between this existence read and an authenticated provider observation.
    initialObservation: true,
  });
}

/** A read observation, not a webhook or a claim we witnessed PR creation. */
export async function observePullRequest(principal: string, pr: GitHubPullRequest): Promise<void> {
  const ref = githubLoopRef(pr.html_url, 'pull');
  if (!ref || !principal.startsWith('did:')) return;
  const state = observedState(pr);
  if (!state) return;
  const terminal = state === 'merged' || state === 'closed';
  await emitKernelLoopEvent(terminal ? 'loop.finished' : 'loop.started', {
    loopId: prLoopId(principal, ref),
    kind: 'pr',
    principal,
    refs: { pr: ref },
    state,
    summary: `GitHub pull request observed ${state}`,
    at: new Date().toISOString(),
    source: 'github.getPullRequest',
    providerUpdatedAt: pr.updated_at,
  });
}

function observedState(pr: GitHubPullRequest): string | undefined {
  if (pr.merged === true || pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.state === 'open') return pr.draft ? 'draft' : 'open';
  return undefined;
}
