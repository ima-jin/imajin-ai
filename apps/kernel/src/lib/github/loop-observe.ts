import { emitKernelLoopEvent } from '@/src/lib/loops/emit';
import { githubLoopRef } from '@/src/lib/warp/loop-refs';
import type { GitHubPullRequest } from './entities';

/** A read observation, not a webhook or a claim we witnessed PR creation. */
export async function observePullRequest(principal: string, pr: GitHubPullRequest): Promise<void> {
  const ref = githubLoopRef(pr.html_url, 'pull');
  if (!ref || !principal.startsWith('did:')) return;
  const state = observedState(pr);
  if (!state) return;
  const terminal = state === 'merged' || state === 'closed';
  await emitKernelLoopEvent(terminal ? 'loop.finished' : 'loop.started', {
    loopId: `pr:${principal}:${ref}`,
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
