import type { LoopRefs } from '@/src/lib/loops/types';
import type { WarpAgentRun } from './dispatch';

/** Accept exact GitHub entity URLs only, never branch names or prompt prose. */
export function githubLoopRef(value: unknown, entity: 'issues' | 'pull'): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) return undefined;
    const parts = url.pathname.split('/');
    if (parts.length !== 5 || !parts[1] || !parts[2] || parts[3] !== entity || !/^[1-9]\d*$/.test(parts[4])) return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function warpRunLoopRefs(run: Pick<WarpAgentRun, 'runId' | 'sessionId' | 'triggerUrl' | 'artifacts'>): LoopRefs {
  const refs: LoopRefs = { runId: run.runId };
  if (run.sessionId) refs.sessionKey = run.sessionId;
  const issue = githubLoopRef(run.triggerUrl, 'issues');
  if (issue) refs.issue = issue;
  const prs = warpRunPrArtifacts(run);
  const triggerPr = githubLoopRef(run.triggerUrl, 'pull');
  if (triggerPr) refs.pr = triggerPr;
  else if (prs.length === 1) refs.pr = prs[0];
  return refs;
}

/** Only provider-typed artifacts establish PR appearance, not trigger URLs. */
export function warpRunPrArtifacts(run: Pick<WarpAgentRun, 'artifacts'>): string[] {
  return [...new Set(run.artifacts
    .filter((artifact) => artifact.artifactType === 'PULL_REQUEST')
    .map((artifact) => githubLoopRef(artifact.data?.url, 'pull'))
    .filter((url): url is string => url !== undefined))];
}
