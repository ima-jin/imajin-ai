/** Registry-first Spend adapter; legacy Warp derivation is missing-loop only. */
import {
  costPerClosedIssue, defaultInterimDeps, deriveInterimSpend, groupByIssue,
  monthStartIso, RECENT_RUN_COUNT, MAX_GITHUB_LOOKUPS,
  type InterimDeps, type InterimRunCost, type InterimSpend, type IssueRef, type IssueState,
} from './spend-interim-join';
import {
  readRegistrySpend, registeredRunIds, unregisteredSessionIds, type RegistryRunCost, type RegistrySpend,
} from '@/src/lib/loops/spend';
import { mapWithConcurrency } from '@/src/lib/async/sequential';

/** Only explicit repository-qualified refs, never branch-name inference. */
export function githubSubject(ref: unknown, kind: 'issue' | 'pr'): IssueRef | null {
  if (typeof ref !== 'string') return null;
  const path = kind === 'issue' ? 'issues' : 'pull';
  const url = new RegExp(`^https://github\\.com/([\\w.-]+/[\\w.-]+)/${path}/(\\d+)/?$`).exec(ref);
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  const match = url ?? qualified;
  if (!match) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: match[1], number } : null;
}

function registryRun(run: RegistryRunCost): InterimRunCost {
  const issue = githubSubject(run.refs.issue, 'issue');
  const pr = githubSubject(run.refs.pr, 'pr');
  return {
    runId: run.runId, title: run.summary, state: run.state, createdAt: run.startedAt,
    warp: null, metered: run.metered,
    attribution: run.metered?.usd === null || !run.metered ? 'unattributed' : 'metered',
    linkage: {
      branch: null,
      prUrl: pr ? `https://github.com/${pr.repo}/pull/${pr.number}` : null,
      prRepo: pr?.repo ?? null, prNumber: pr?.number ?? null,
      issue, issueVia: issue ? 'registry' : null,
    },
  };
}

export interface RegistrySpendDeps {
  readRegistry: typeof readRegistrySpend;
  registered: typeof registeredRunIds;
  interim: InterimDeps;
}

export interface RegistryLaneSpend extends InterimSpend {
  /** PR totals come from explicit signed registry refs, not guessed branches. */
  prs: RegistrySpend['prs'];
}

async function issueStates(runs: InterimRunCost[], deps: InterimDeps): Promise<Map<string, IssueState>> {
  const refs = new Map<string, IssueRef>();
  for (const run of runs) {
    const ref = run.linkage.issue;
    if (ref) refs.set(`${ref.repo}#${ref.number}`, ref);
  }
  const entries = await mapWithConcurrency([...refs], 4, async ([key, ref]) => {
    const state = await deps.readIssueState(ref.repo, ref.number).catch(() => 'unknown' as const);
    return [key, state] as const;
  });
  return new Map(entries);
}

/** One per-request budget/cache shared by fallback and registry issue reads. */
function boundedIssueReader(deps: InterimDeps): InterimDeps['readIssueState'] {
  const cache = new Map<string, Promise<IssueState>>();
  return (repo, number) => {
    const key = `${repo}#${number}`;
    const cached = cache.get(key);
    if (cached) return cached;
    if (cache.size >= MAX_GITHUB_LOOKUPS) return Promise.resolve('unknown');
    const state = deps.readIssueState(repo, number).catch(() => 'unknown' as const);
    cache.set(key, state);
    return state;
  };
}

export async function buildRegistrySpend(
  principal: string, deps: RegistrySpendDeps, now: Date = new Date(),
): Promise<RegistryLaneSpend> {
  const from = monthStartIso(now);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  // Read registry first; never downgrade a DB failure to a heuristic join.
  const registry = await deps.readRegistry(principal, from, to);
  const interim = { ...deps.interim, readIssueState: boundedIssueReader(deps.interim) };
  const fallback = await deriveInterimSpend(principal, interim, now, {
    registeredRunIds: (ids) => deps.registered(principal, ids),
    recentLimit: Number.MAX_SAFE_INTEGER,
  });
  const runs = [...registry.runs.map(registryRun), ...fallback.runs];
  runs.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.runId.localeCompare(b.runId));
  const states = await issueStates(runs, interim);
  const issues = groupByIssue(runs, states);
  return {
    label: fallback.runs.length > 0
      ? `registry · ${fallback.runs.length} legacy runs use interim fallback`
      : 'registry · signed loop refs + usage.incurred',
    windowFrom: from,
    runsAvailable: registry.runs.length > 0 || fallback.runsAvailable,
    runsTruncated: fallback.runsTruncated,
    githubAvailable: [...states.values()].some((state) => state !== 'unknown'),
    runs: runs.slice(0, RECENT_RUN_COUNT), issues,
    closedIssueCost: costPerClosedIssue(issues), prs: registry.prs,
  };
}

export function readRegistryLaneSpend(principal: string): Promise<RegistryLaneSpend> {
  const interim = defaultInterimDeps(principal);
  return buildRegistrySpend(principal, {
    readRegistry: readRegistrySpend,
    registered: registeredRunIds,
    interim: {
      ...interim,
      async meteredBySession(did, ids) {
        return interim.meteredBySession(did, await unregisteredSessionIds(did, ids));
      },
    },
  });
}
