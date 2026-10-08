/**
 * INTERIM run → cost → issue derivation for the /jin Spend lane (#2725).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ SWAP NOTE (#2290): this whole module is a STOPGAP. When the loop         │
 * │ registry projection (#2290, v0.9.0) lands, its                           │
 * │ run → subject issue/PR → `usage.incurred` correlation replaces this      │
 * │ file. Nothing else in the lane knows how the join is derived — the       │
 * │ route (`app/jin/api/spend/runs/route.ts`) calls `readInterimSpend` and   │
 * │ the panel renders its labelled output — so the swap is ONE file.         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Ruling (Ryan, 2026-10-07, a+c): until #2290, derive the join with NO schema
 * change from Warp run data plus branch names. Sources, in order:
 *
 *   1. Per-run cost
 *      - "Warp-reported": `requestUsage { inferenceCost, computeCost,
 *        platformCost }` on the run (`GET /warp/api/runs`, same reader as
 *        `listAgentRuns`). These are Warp's own units — NOT converted, NOT
 *        assumed to be USD.
 *      - "Metered": `usage.incurred` rows whose `session_id` equals the run's
 *        id / session id / conversation id (#2726 stamps `session_id` on
 *        external ingest). These are `cost_usd`.
 *      The two are never summed (different units, possible double count);
 *      both are reported side by side. When neither resolves the run is
 *      "unattributed" — a number is never invented.
 *
 *   2. Run → issue
 *      head branch `feat|fix|chore/<n>-slug` (PR artifact `data.branch`),
 *      else `Closes #N` in the PR body. When `artifacts[]` is empty (agents
 *      often open PRs with `gh`) fall back to a PR URL / `PR #N` / branch
 *      mention in `statusMessage`.
 *
 *   3. Issue closure
 *      Through the kernel's existing GitHub connector read path
 *      (`getIssue` / `getPullRequest`, `github:read` grant + the operator's
 *      already-sealed credential). No new credential. Any failure (no grant,
 *      no credential, GitHub error) leaves the state `unknown` — never guessed.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, usageIncurred } from '@/src/db';
import { listAgentRuns, type WarpAgentRun, type WarpRunUsage } from '@/src/lib/warp/dispatch';
import { getIssue, getPullRequest } from '@/src/lib/github/connector';
import { BUG_TRACKER_REPO } from '@/src/lib/github/bug-import';
import { mapWithConcurrency } from '@/src/lib/async/sequential';

const log = createLogger('kernel:jin:spend-interim');

/** Shown in the UI next to every number this module derives. */
export const INTERIM_LABEL = 'interim · derived from Warp runs + branch names (until #2290)';

/** Max runs read for the month, and max GitHub lookups per request. */
const RUN_LIMIT = 100;
const MAX_GITHUB_LOOKUPS = 30;
const GITHUB_CONCURRENCY = 4;
/** Max recent runs returned for the compact list. */
export const RECENT_RUN_COUNT = 8;

// ── Types ─────────────────────────────────────────────────────────────────────

export type IssueState = 'open' | 'closed' | 'unknown';

export interface WarpReportedCost {
  inference: number | null;
  compute: number | null;
  platform: number | null;
  /** Sum of the non-null parts; null when Warp reported none of them. */
  total: number | null;
}

export interface MeteredCost {
  usd: number | null;
  turns: number;
}

export type RunAttribution = 'metered' | 'warp-reported' | 'unattributed';

export interface IssueRef {
  repo: string;
  number: number;
}

export interface RunLinkage {
  branch: string | null;
  prUrl: string | null;
  prRepo: string | null;
  prNumber: number | null;
  issue: IssueRef | null;
  issueVia: 'branch' | 'pr-body' | null;
}

export interface InterimRunCost {
  runId: string;
  title: string | null;
  state: string | null;
  createdAt: string | null;
  warp: WarpReportedCost | null;
  metered: MeteredCost | null;
  attribution: RunAttribution;
  linkage: RunLinkage;
}

export interface InterimIssueCost {
  repo: string;
  number: number;
  state: IssueState;
  runCount: number;
  warpTotal: number | null;
  meteredUsd: number | null;
}

export interface ClosedIssueCost {
  closedCount: number;
  unknownCount: number;
  /** Warp-reported units per closed issue; null when no closed issue has a Warp cost. */
  warpPerIssue: number | null;
  /** Metered USD per closed issue; null when no closed issue has a metered cost. */
  meteredUsdPerIssue: number | null;
}

export interface InterimSpend {
  label: string;
  windowFrom: string;
  /** False when Warp runs could not be read (no key / upstream error). */
  runsAvailable: boolean;
  runsTruncated: boolean;
  /** True when at least one issue state came back from GitHub. */
  githubAvailable: boolean;
  runs: InterimRunCost[];
  issues: InterimIssueCost[];
  closedIssueCost: ClosedIssueCost;
}

/** Everything the derivation touches outside itself — injectable for tests. */
export interface InterimDeps {
  listRuns(principalDid: string, createdAfter: string): Promise<{ runs: WarpAgentRun[]; hasNextPage: boolean }>;
  meteredBySession(principalDid: string, sessionIds: string[]): Promise<Map<string, MeteredCost>>;
  /** `null` when the PR could not be read. */
  readPullRequest(repo: string, number: number): Promise<{ headRef: string | null; body: string | null } | null>;
  readIssueState(repo: string, number: number): Promise<IssueState>;
}

// ── Pure derivation ───────────────────────────────────────────────────────────

const BRANCH_ISSUE_RE = /^(?:refs\/heads\/)?(?:feat|fix|chore)\/(\d+)-/;
const BRANCH_MENTION_RE = /\b(?:feat|fix|chore)\/\d+-[\w.-]+/;
const PR_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const PR_REF_RE = /\bPR\s*#(\d+)/i;
const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i;

/** Issue number from a `feat|fix|chore/<n>-slug` branch, or null. */
export function issueNumberFromBranch(branch: string | null): number | null {
  if (!branch) return null;
  const match = BRANCH_ISSUE_RE.exec(branch.trim());
  return match ? Number(match[1]) : null;
}

/** Issue number from a `Closes #N` / `Fixes #N` / `Resolves #N` PR body, or null. */
export function issueNumberFromBody(body: string | null): number | null {
  if (!body) return null;
  const match = CLOSES_RE.exec(body);
  return match ? Number(match[1]) : null;
}

/** Total of the non-null Warp cost parts, or null when every part is null. */
export function warpCostOf(usage: WarpRunUsage | null): WarpReportedCost | null {
  if (!usage) return null;
  const parts = [usage.inferenceCost, usage.computeCost, usage.platformCost];
  const known = parts.filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
  if (known.length === 0) return null;
  return {
    inference: usage.inferenceCost,
    compute: usage.computeCost,
    platform: usage.platformCost,
    total: known.reduce((sum, p) => sum + p, 0),
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface PrHint {
  prUrl: string | null;
  prRepo: string | null;
  prNumber: number | null;
  branch: string | null;
}

const EMPTY_HINT: PrHint = { prUrl: null, prRepo: null, prNumber: null, branch: null };

function hintFromArtifacts(run: WarpAgentRun): PrHint {
  const pr = run.artifacts.find((a) => a.artifactType === 'PULL_REQUEST' && a.data);
  if (!pr?.data) return EMPTY_HINT;
  const prUrl = asString(pr.data.url);
  const urlMatch = prUrl ? PR_URL_RE.exec(prUrl) : null;
  return {
    prUrl,
    prRepo: urlMatch ? urlMatch[1] : null,
    prNumber: urlMatch ? Number(urlMatch[2]) : null,
    branch: asString(pr.data.branch),
  };
}

/** Fallback when `artifacts[]` has no PR: scan `statusMessage` for a PR URL, `PR #N`, or a branch name. */
function hintFromStatusMessage(run: WarpAgentRun): PrHint {
  const text = run.statusMessage?.message ?? '';
  if (!text) return EMPTY_HINT;
  const branchMatch = BRANCH_MENTION_RE.exec(text);
  const branch = branchMatch ? branchMatch[0] : null;
  const urlMatch = PR_URL_RE.exec(text);
  if (urlMatch) {
    return {
      prUrl: `https://github.com/${urlMatch[1]}/pull/${urlMatch[2]}`,
      prRepo: urlMatch[1],
      prNumber: Number(urlMatch[2]),
      branch,
    };
  }
  const refMatch = PR_REF_RE.exec(text);
  return { prUrl: null, prRepo: null, prNumber: refMatch ? Number(refMatch[1]) : null, branch };
}

/** PR hint for a run: PR artifact first, then the `statusMessage` fallback. */
export function prHintOf(run: WarpAgentRun): PrHint {
  const fromArtifacts = hintFromArtifacts(run);
  if (fromArtifacts.prUrl || fromArtifacts.branch) return fromArtifacts;
  return hintFromStatusMessage(run);
}

/** Roll one run's cost: metered `usage.incurred` (USD) next to Warp-reported (units). */
function costsOf(run: WarpAgentRun, metered: Map<string, MeteredCost>): {
  warp: WarpReportedCost | null;
  metered: MeteredCost | null;
  attribution: RunAttribution;
} {
  const warp = warpCostOf(run.requestUsage);
  const keys = [run.runId, run.sessionId, run.conversationId].filter((k): k is string => !!k);
  let usd: number | null = null;
  let turns = 0;
  for (const key of new Set(keys)) {
    const hit = metered.get(key);
    if (!hit) continue;
    turns += hit.turns;
    if (hit.usd !== null) usd = (usd ?? 0) + hit.usd;
  }
  const joined = turns > 0 ? { usd, turns } : null;
  if (joined && joined.usd !== null) return { warp, metered: joined, attribution: 'metered' };
  if (warp) return { warp, metered: joined, attribution: 'warp-reported' };
  return { warp, metered: joined, attribution: 'unattributed' };
}

// ── Linkage (needs GitHub only when the branch carries no issue number) ───────

async function linkageOf(run: WarpAgentRun, deps: InterimDeps, budget: { left: number }): Promise<RunLinkage> {
  const hint = prHintOf(run);
  const repo = hint.prRepo ?? BUG_TRACKER_REPO;
  let branch = hint.branch;
  let issueNumber = issueNumberFromBranch(branch);
  let issueVia: RunLinkage['issueVia'] = issueNumber === null ? null : 'branch';

  if (issueNumber === null && hint.prNumber !== null && budget.left > 0) {
    budget.left -= 1;
    const pr = await deps.readPullRequest(repo, hint.prNumber);
    branch = branch ?? pr?.headRef ?? null;
    const fromHead = issueNumberFromBranch(pr?.headRef ?? null);
    const fromBody = fromHead === null ? issueNumberFromBody(pr?.body ?? null) : null;
    issueNumber = fromHead ?? fromBody;
    if (fromHead !== null) issueVia = 'branch';
    else if (fromBody !== null) issueVia = 'pr-body';
  }

  return {
    branch,
    prUrl: hint.prUrl,
    prRepo: hint.prRepo,
    prNumber: hint.prNumber,
    issue: issueNumber === null ? null : { repo, number: issueNumber },
    issueVia,
  };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

function addNullable(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  return (current ?? 0) + next;
}

function issueKey(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

/** Group runs by linked issue and attach closure state. */
export function groupByIssue(runs: InterimRunCost[], states: Map<string, IssueState>): InterimIssueCost[] {
  const byIssue = new Map<string, InterimIssueCost>();
  for (const run of runs) {
    const ref = run.linkage.issue;
    if (!ref) continue;
    const key = issueKey(ref);
    const row =
      byIssue.get(key) ??
      { repo: ref.repo, number: ref.number, state: states.get(key) ?? 'unknown', runCount: 0, warpTotal: null, meteredUsd: null };
    row.runCount += 1;
    row.warpTotal = addNullable(row.warpTotal, run.warp?.total ?? null);
    row.meteredUsd = addNullable(row.meteredUsd, run.metered?.usd ?? null);
    byIssue.set(key, row);
  }
  return [...byIssue.values()].sort((a, b) => b.number - a.number);
}

/** Cost per closed issue over the supplied issues; each unit averaged separately. */
export function costPerClosedIssue(issues: InterimIssueCost[]): ClosedIssueCost {
  const closed = issues.filter((i) => i.state === 'closed');
  const unknownCount = issues.filter((i) => i.state === 'unknown').length;
  const warp = closed.reduce<number | null>((sum, i) => addNullable(sum, i.warpTotal), null);
  const usd = closed.reduce<number | null>((sum, i) => addNullable(sum, i.meteredUsd), null);
  return {
    closedCount: closed.length,
    unknownCount,
    warpPerIssue: closed.length > 0 && warp !== null ? warp / closed.length : null,
    meteredUsdPerIssue: closed.length > 0 && usd !== null ? usd / closed.length : null,
  };
}

/** `YYYY-MM-01T00:00:00.000Z` for the month containing `now`. */
export function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function resolveIssueStates(
  runs: InterimRunCost[],
  deps: InterimDeps,
): Promise<Map<string, IssueState>> {
  const refs = new Map<string, IssueRef>();
  for (const run of runs) {
    if (run.linkage.issue) refs.set(issueKey(run.linkage.issue), run.linkage.issue);
  }
  const wanted = [...refs.entries()].slice(0, MAX_GITHUB_LOOKUPS);
  const resolved = await mapWithConcurrency(wanted, GITHUB_CONCURRENCY, async ([key, ref]) => {
    const state = await deps.readIssueState(ref.repo, ref.number);
    return [key, state] as const;
  });
  return new Map(resolved);
}

/** Derive the whole interim picture from injected readers. Pure aside from `deps`. */
export async function deriveInterimSpend(
  principalDid: string,
  deps: InterimDeps,
  now: Date = new Date(),
): Promise<InterimSpend> {
  const windowFrom = monthStartIso(now);
  const base = { label: INTERIM_LABEL, windowFrom };
  let page: Awaited<ReturnType<InterimDeps['listRuns']>>;
  try {
    page = await deps.listRuns(principalDid, windowFrom);
  } catch (err) {
    log.warn({ err: String(err) }, 'spend lane: Warp runs unavailable');
    return {
      ...base,
      runsAvailable: false,
      runsTruncated: false,
      githubAvailable: false,
      runs: [],
      issues: [],
      closedIssueCost: costPerClosedIssue([]),
    };
  }

  const sessionKeys = page.runs.flatMap((r) => [r.runId, r.sessionId, r.conversationId]).filter((k): k is string => !!k);
  const metered = await deps.meteredBySession(principalDid, [...new Set(sessionKeys)]).catch((err) => {
    log.warn({ err: String(err) }, 'spend lane: metered join unavailable');
    return new Map<string, MeteredCost>();
  });

  const budget = { left: MAX_GITHUB_LOOKUPS };
  const runs = await mapWithConcurrency(page.runs, GITHUB_CONCURRENCY, async (run): Promise<InterimRunCost> => ({
    runId: run.runId,
    title: run.title,
    state: run.state,
    createdAt: run.createdAt,
    ...costsOf(run, metered),
    linkage: await linkageOf(run, deps, budget),
  }));

  const states = await resolveIssueStates(runs, deps);
  const issues = groupByIssue(runs, states);
  return {
    ...base,
    runsAvailable: true,
    runsTruncated: page.hasNextPage,
    githubAvailable: [...states.values()].some((s) => s !== 'unknown'),
    runs: runs.slice(0, RECENT_RUN_COUNT),
    issues,
    closedIssueCost: costPerClosedIssue(issues),
  };
}

// ── Default readers (existing tables / APIs only; read-only) ──────────────────

async function meteredBySession(principalDid: string, sessionIds: string[]): Promise<Map<string, MeteredCost>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db
    .select({
      sessionId: usageIncurred.sessionId,
      usd: sql<string | null>`SUM(${usageIncurred.costUsd})`,
      turns: sql<string>`COUNT(*)`,
    })
    .from(usageIncurred)
    .where(and(eq(usageIncurred.principalDid, principalDid), inArray(usageIncurred.sessionId, sessionIds)))
    .groupBy(usageIncurred.sessionId);

  const out = new Map<string, MeteredCost>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    out.set(row.sessionId, { usd: row.usd === null ? null : Number(row.usd), turns: Number(row.turns) });
  }
  return out;
}

/** Operator DID is resolved per call so the readers can use the operator's own authorised credentials. */
export function defaultInterimDeps(operatorDid: string): InterimDeps {
  return {
    async listRuns(principalDid, createdAfter) {
      const page = await listAgentRuns(principalDid, { createdAfter, limit: RUN_LIMIT });
      return { runs: page.runs, hasNextPage: page.hasNextPage };
    },
    meteredBySession,
    async readPullRequest(repo, number) {
      try {
        const pr = await getPullRequest(operatorDid, repo, number);
        return { headRef: pr.head?.ref ?? null, body: pr.body };
      } catch {
        return null;
      }
    },
    async readIssueState(repo, number) {
      try {
        const issue = await getIssue(operatorDid, repo, number);
        return issue.state === 'closed' ? 'closed' : 'open';
      } catch {
        return 'unknown';
      }
    },
  };
}

/** Entry point for the route: the interim spend picture for the operator, this month. */
export function readInterimSpend(operatorDid: string): Promise<InterimSpend> {
  return deriveInterimSpend(operatorDid, defaultInterimDeps(operatorDid));
}
