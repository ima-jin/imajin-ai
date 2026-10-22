import { createLogger } from '@imajin/logger';
import type { LoopJson } from '@/src/lib/loops/serialize';
import { redactLoopText } from '@/src/lib/loops/output-redaction';
import { mapWithConcurrency } from '@/src/lib/async/sequential';
import { getIssue, getPullRequest } from '@/src/lib/github/connector';
import { getAgentRun, isTerminalRunState, type WarpAgentRun } from './dispatch';
import { emitWarpRunLoopEvent, type WarpRunLoopTransition } from './loop-emit';
import { githubLoopRef, warpRunLoopRefs, warpRunPrArtifacts } from './loop-refs';

const log = createLogger('kernel:warp-reconcile');

/** Short, bounded, principal-scoped read cache; never cache failed authorization. */
const observations = new Map<string, { until: number; value: Promise<unknown> }>();
const MAX_OBSERVATIONS = 1000;
const OBSERVATION_TTL_MS = 60_000;

async function observed<T>(principal: string, ref: string, read: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([principal, ref]);
  const known = observations.get(key);
  if (known && known.until > Date.now()) return known.value as Promise<T>;
  if (observations.size >= MAX_OBSERVATIONS) observations.clear();
  const value = read();
  const entry = { until: Date.now() + OBSERVATION_TTL_MS, value };
  observations.set(key, entry);
  try {
    return await value;
  } catch (error) {
    if (observations.get(key) === entry) observations.delete(key);
    throw error;
  }
}

/** PRs take precedence over issue closure; one held draft keeps the run held. */
async function derive(loop: LoopJson, run: WarpAgentRun): Promise<Derived> {
  const refs = warpRunLoopRefs(run);
  const prs = [...new Set([
    ...warpRunPrArtifacts(run),
    githubLoopRef(refs.pr, 'pull'),
    githubLoopRef(loop.refs.pr, 'pull'),
  ].filter((ref): ref is string => !!ref))];
  const result = prs.length > 0
    ? await derivePullRequests(loop.principal, prs)
    : await deriveUnlinkedRun(loop, run);
  if (result) return { ...result, summary: result.summary.slice(0, 2000) };
  const summary = (run.statusMessage?.message.trim() || loop.summary).split(/\r?\n/, 1)[0].slice(0, 2000);
  return { type: 'loop.progress', state: 'blocked', summary };
}

function entity(ref: string): { repo: string; number: number } {
  const parts = new URL(ref).pathname.split('/');
  return { repo: `${parts[1]}/${parts[2]}`, number: Number(parts[4]) };
}

type Derived = Pick<WarpRunLoopTransition, 'state' | 'summary' | 'type'>;

async function derivePullRequests(principal: string, prs: string[]): Promise<Derived | undefined> {
  const states = await Promise.all(prs.map(ref => observed(principal, ref, async () => {
    const { repo, number } = entity(ref);
    const pr = await getPullRequest(principal, repo, number);
    return { number, state: pr.merged === true || pr.merged_at ? 'merged' : pr.state, draft: pr.draft };
  })));
  if (states.every(pr => pr.state === 'merged' || pr.state === 'closed')) {
    const outcomes = states.map(pr => `PR #${pr.number} ${pr.state}`).join(' · ');
    return { type: 'loop.finished', state: 'resolved',
      summary: `resolved · ${outcomes}` };
  }
  if (states.every(pr => pr.state === 'merged' || pr.state === 'closed' || (pr.state === 'open' && pr.draft === false))) {
    const awaiting = states.filter(pr => pr.state === 'open').map(pr => `PR #${pr.number}`).join(' · ');
    return { type: 'loop.progress', state: 'awaiting_review',
      summary: `awaiting review · ${awaiting}` };
  }
  return undefined;
}

async function deriveUnlinkedRun(loop: LoopJson, run: WarpAgentRun): Promise<Derived | undefined> {
  const principal = loop.principal;
  const refs = warpRunLoopRefs(run);
  const issue = githubLoopRef(refs.issue ?? loop.refs.issue, 'issues');
  if (issue) {
    const { repo, number } = entity(issue);
    const current = await observed(principal, issue, () => getIssue(principal, repo, number));
    if (current.state === 'closed') {
      return { type: 'loop.finished', state: 'resolved', summary: `resolved · issue #${number} closed` };
    }
  }
  const parentRunId = run.parentRunId ?? loop.parentLoopId;
  if (parentRunId) {
    const parent = await observed(principal, `warp:${parentRunId}`, () => getAgentRun(principal, parentRunId));
    if (isTerminalRunState(parent.state)) {
      return { type: 'loop.finished', state: 'superseded', summary: `superseded · parent run ${parent.state.toLowerCase()}` };
    }
  }
  return undefined;
}

/** Lazy backfill includes old BLOCKED rows, with no lookback/age-out or direct SQL writes. */
async function reconcileOne(principal: string, loop: LoopJson): Promise<LoopJson> {
  if (loop.principal !== principal || loop.kind !== 'warp.run' || loop.finishedAt
    || !(loop.state.toLowerCase() === 'blocked' || loop.state === 'awaiting_review' || loop.lastEventType === 'loop.blocked')) return loop;
  try {
    const run = await observed(principal, `warp:${loop.loopId}`, () => getAgentRun(principal, loop.loopId));
    // A resumed/running segment is owned by the normal lifecycle watch.
    if (run.state !== 'BLOCKED') return loop;
    const observation = await derive(loop, run);
    const derived = { ...observation, summary: redactLoopText(observation.summary) };
    if (derived.state === loop.state && derived.summary === loop.summary && loop.lastEventType !== 'loop.blocked') return loop;
    if (derived.state === 'blocked' && loop.state === 'blocked' && derived.summary === loop.summary) return loop;
    const at = new Date().toISOString();
    const accepted = await emitWarpRunLoopEvent({
      ...derived, runId: loop.loopId, principalDid: principal, parentRunId: run.parentRunId ?? loop.parentLoopId,
      at, refs: warpRunLoopRefs(run),
    });
    if (!accepted) return loop;
    // Read-after-ingest representation only: the signed projection is the sole writer.
    return { ...loop, state: derived.state, summary: derived.summary, lastEventType: derived.type, lastSeenAt: at, updatedAt: at,
      finishedAt: derived.type === 'loop.finished' ? at : null };
  } catch {
    // Never log provider errors: credentials/private response text may be embedded.
    log.warn({ loopId: loop.loopId }, 'Warp blocker observation unavailable; retaining signed state');
    return loop;
  }
}

export async function reconcileWarpBlockers(principal: string, loops: LoopJson[]): Promise<LoopJson[]> {
  // Bound provider concurrency even on a 200-row operator page.
  return mapWithConcurrency(loops, 4, loop => reconcileOne(principal, loop));
}
