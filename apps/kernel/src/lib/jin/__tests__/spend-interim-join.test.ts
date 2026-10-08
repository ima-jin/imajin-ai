import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockSelect, mockListAgentRuns, mockGetIssue, mockGetPullRequest, state } = vi.hoisted(() => {
  const state = { rows: [] as unknown[] };
  const chain = {
    from: () => chain,
    where: () => chain,
    groupBy: () => Promise.resolve(state.rows),
  };
  return {
    state,
    mockSelect: vi.fn(() => chain),
    mockListAgentRuns: vi.fn(),
    mockGetIssue: vi.fn(),
    mockGetPullRequest: vi.fn(),
  };
});

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  usageIncurred: { sessionId: 'sessionId', costUsd: 'costUsd', principalDid: 'principalDid' },
}));
vi.mock('@/src/lib/warp/dispatch', () => ({ listAgentRuns: mockListAgentRuns }));
vi.mock('@/src/lib/github/connector', () => ({ getIssue: mockGetIssue, getPullRequest: mockGetPullRequest }));
vi.mock('@/src/lib/github/bug-import', () => ({ BUG_TRACKER_REPO: 'ima-jin/imajin-ai' }));

import {
  INTERIM_LABEL,
  costPerClosedIssue,
  defaultInterimDeps,
  deriveInterimSpend,
  groupByIssue,
  issueNumberFromBody,
  issueNumberFromBranch,
  monthStartIso,
  prHintOf,
  readInterimSpend,
  warpCostOf,
  type InterimDeps,
  type InterimIssueCost,
  type InterimRunCost,
  type MeteredCost,
} from '../spend-interim-join';
import type { WarpAgentRun } from '@/src/lib/warp/dispatch';

const OPERATOR = 'did:imajin:operator';
const NOW = new Date('2026-10-08T04:45:00Z');

function run(overrides: Partial<WarpAgentRun> = {}): WarpAgentRun {
  return {
    runId: 'run-1',
    state: 'SUCCEEDED',
    sessionLink: null,
    title: 'a run',
    configName: null,
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: null,
    startedAt: null,
    runTime: null,
    statusMessage: null,
    source: null,
    executionLocation: null,
    sessionId: null,
    conversationId: null,
    parentRunId: null,
    triggerUrl: null,
    isSandboxRunning: null,
    requestUsage: null,
    creator: null,
    executor: null,
    modelId: null,
    environmentId: null,
    skillSpec: null,
    agentSkill: null,
    schedule: null,
    artifacts: [],
    ...overrides,
  };
}

function prArtifact(url: string | null, branch: string | null) {
  return { artifactType: 'PULL_REQUEST', createdAt: null, data: { ...(url ? { url } : {}), ...(branch ? { branch } : {}) } };
}

function deps(overrides: Partial<InterimDeps> = {}): InterimDeps {
  return {
    listRuns: vi.fn(async () => ({ runs: [], hasNextPage: false })),
    meteredBySession: vi.fn(async () => new Map<string, MeteredCost>()),
    readPullRequest: vi.fn(async () => null),
    readIssueState: vi.fn(async () => 'unknown' as const),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
});

describe('branch / body parsing', () => {
  it('reads the issue number from feat|fix|chore branches only', () => {
    expect(issueNumberFromBranch('feat/2725-jin-spend-lane')).toBe(2725);
    expect(issueNumberFromBranch('fix/12-x')).toBe(12);
    expect(issueNumberFromBranch('refs/heads/chore/7-y')).toBe(7);
    expect(issueNumberFromBranch('docs/9-z')).toBeNull();
    expect(issueNumberFromBranch('feat/no-number')).toBeNull();
    expect(issueNumberFromBranch(null)).toBeNull();
  });

  it('reads Closes/Fixes/Resolves #N from a PR body', () => {
    expect(issueNumberFromBody('Closes #2725')).toBe(2725);
    expect(issueNumberFromBody('this fixes #4')).toBe(4);
    expect(issueNumberFromBody('Resolved #8 yesterday')).toBe(8);
    expect(issueNumberFromBody('Refs #2725')).toBeNull();
    expect(issueNumberFromBody(null)).toBeNull();
  });
});

describe('warpCostOf', () => {
  it('sums non-null parts and keeps the parts as reported', () => {
    expect(warpCostOf({ inferenceCost: 1.5, computeCost: null, platformCost: 0.5 })).toEqual({
      inference: 1.5,
      compute: null,
      platform: 0.5,
      total: 2,
    });
  });

  it('is null when Warp reported nothing', () => {
    expect(warpCostOf(null)).toBeNull();
    expect(warpCostOf({ inferenceCost: null, computeCost: null, platformCost: null })).toBeNull();
  });
});

describe('prHintOf', () => {
  it('prefers the PULL_REQUEST artifact (url + branch)', () => {
    const hint = prHintOf(run({ artifacts: [prArtifact('https://github.com/ima-jin/imajin-ai/pull/99', 'feat/5-x')] }));
    expect(hint).toEqual({
      prUrl: 'https://github.com/ima-jin/imajin-ai/pull/99',
      prRepo: 'ima-jin/imajin-ai',
      prNumber: 99,
      branch: 'feat/5-x',
    });
  });

  it('handles an artifact with a branch but no url', () => {
    const hint = prHintOf(run({ artifacts: [prArtifact(null, 'fix/3-y')] }));
    expect(hint).toMatchObject({ prUrl: null, prNumber: null, branch: 'fix/3-y' });
  });

  it('falls back to a PR URL in statusMessage when artifacts are empty', () => {
    const hint = prHintOf(
      run({ statusMessage: { message: 'opened https://github.com/ima-jin/imajin-ai/pull/12 on feat/7-thing', errorCode: null, retryable: null } }),
    );
    expect(hint).toEqual({
      prUrl: 'https://github.com/ima-jin/imajin-ai/pull/12',
      prRepo: 'ima-jin/imajin-ai',
      prNumber: 12,
      branch: 'feat/7-thing',
    });
  });

  it('falls back to a bare "PR #N" mention', () => {
    const hint = prHintOf(run({ statusMessage: { message: 'Opened PR #44', errorCode: null, retryable: null } }));
    expect(hint).toEqual({ prUrl: null, prRepo: null, prNumber: 44, branch: null });
  });

  it('is empty when nothing mentions a PR', () => {
    expect(prHintOf(run())).toEqual({ prUrl: null, prRepo: null, prNumber: null, branch: null });
    expect(prHintOf(run({ statusMessage: { message: 'done', errorCode: null, retryable: null } }))).toEqual({
      prUrl: null,
      prRepo: null,
      prNumber: null,
      branch: null,
    });
  });

  it('ignores non-PR artifacts', () => {
    const hint = prHintOf(run({ artifacts: [{ artifactType: 'PLAN', createdAt: null, data: { url: 'x' } }, { artifactType: 'PULL_REQUEST', createdAt: null, data: null }] }));
    expect(hint.prUrl).toBeNull();
  });
});

describe('aggregation', () => {
  function runCost(over: Partial<InterimRunCost> & { issue?: number }): InterimRunCost {
    return {
      runId: 'r',
      title: null,
      state: null,
      createdAt: null,
      warp: null,
      metered: null,
      attribution: 'unattributed',
      linkage: {
        branch: null,
        prUrl: null,
        prRepo: null,
        prNumber: null,
        issue: over.issue === undefined ? null : { repo: 'o/r', number: over.issue },
        issueVia: over.issue === undefined ? null : 'branch',
      },
      ...over,
    } as InterimRunCost;
  }

  it('groups runs by issue, summing each unit separately and never mixing them', () => {
    const issues = groupByIssue(
      [
        runCost({ issue: 1, warp: { inference: 1, compute: 1, platform: 0, total: 2 } }),
        runCost({ issue: 1, metered: { usd: 0.5, turns: 2 } }),
        runCost({ issue: 2 }),
        runCost({}),
      ],
      new Map([['o/r#1', 'closed' as const]]),
    );
    expect(issues).toEqual([
      { repo: 'o/r', number: 2, state: 'unknown', runCount: 1, warpTotal: null, meteredUsd: null },
      { repo: 'o/r', number: 1, state: 'closed', runCount: 2, warpTotal: 2, meteredUsd: 0.5 },
    ]);
  });

  it('computes cost per closed issue per unit, ignoring open/unknown issues', () => {
    const issues: InterimIssueCost[] = [
      { repo: 'o/r', number: 1, state: 'closed', runCount: 1, warpTotal: 4, meteredUsd: 1 },
      { repo: 'o/r', number: 2, state: 'closed', runCount: 1, warpTotal: 2, meteredUsd: null },
      { repo: 'o/r', number: 3, state: 'open', runCount: 1, warpTotal: 100, meteredUsd: 100 },
      { repo: 'o/r', number: 4, state: 'unknown', runCount: 1, warpTotal: 100, meteredUsd: 100 },
    ];
    expect(costPerClosedIssue(issues)).toEqual({ closedCount: 2, unknownCount: 1, warpPerIssue: 3, meteredUsdPerIssue: 0.5 });
  });

  it('has no per-issue figure with zero closed issues or no cost', () => {
    expect(costPerClosedIssue([])).toEqual({ closedCount: 0, unknownCount: 0, warpPerIssue: null, meteredUsdPerIssue: null });
    expect(
      costPerClosedIssue([{ repo: 'o/r', number: 1, state: 'closed', runCount: 1, warpTotal: null, meteredUsd: null }]),
    ).toMatchObject({ closedCount: 1, warpPerIssue: null, meteredUsdPerIssue: null });
  });

  it('starts the window at the UTC month start', () => {
    expect(monthStartIso(NOW)).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('deriveInterimSpend', () => {
  it('reports runs unavailable (and invents nothing) when Warp cannot be read', async () => {
    const out = await deriveInterimSpend(OPERATOR, deps({ listRuns: vi.fn(async () => { throw new Error('no key'); }) }), NOW);
    expect(out).toMatchObject({ runsAvailable: false, runs: [], issues: [], label: INTERIM_LABEL, windowFrom: '2026-10-01T00:00:00.000Z' });
    expect(out.closedIssueCost.closedCount).toBe(0);
  });

  it('joins metered usage by run id / session id / conversation id and labels attribution honestly', async () => {
    const metered = new Map<string, MeteredCost>([
      ['run-a', { usd: 1.25, turns: 3 }],
      ['sess-b', { usd: null, turns: 2 }],
    ]);
    const out = await deriveInterimSpend(
      OPERATOR,
      deps({
        listRuns: vi.fn(async () => ({
          hasNextPage: true,
          runs: [
            run({ runId: 'run-a', requestUsage: { inferenceCost: 1, computeCost: 1, platformCost: 1 } }),
            run({ runId: 'run-b', sessionId: 'sess-b', requestUsage: { inferenceCost: 2, computeCost: null, platformCost: null } }),
            run({ runId: 'run-c', conversationId: 'conv-c' }),
          ],
        })),
        meteredBySession: vi.fn(async () => metered),
      }),
      NOW,
    );

    expect(out.runsTruncated).toBe(true);
    const [a, b, c] = out.runs;
    expect(a).toMatchObject({ attribution: 'metered', metered: { usd: 1.25, turns: 3 }, warp: { total: 3 } });
    // matched a session but its rows carry no cost → falls back to Warp-reported
    expect(b).toMatchObject({ attribution: 'warp-reported', metered: { usd: null, turns: 2 }, warp: { total: 2 } });
    expect(c).toMatchObject({ attribution: 'unattributed', metered: null, warp: null });
  });

  it('keeps going when the metered join fails', async () => {
    const out = await deriveInterimSpend(
      OPERATOR,
      deps({
        listRuns: vi.fn(async () => ({ runs: [run({ requestUsage: { inferenceCost: 1, computeCost: null, platformCost: null } })], hasNextPage: false })),
        meteredBySession: vi.fn(async () => { throw new Error('db down'); }),
      }),
      NOW,
    );
    expect(out.runs[0].attribution).toBe('warp-reported');
  });

  it('derives issue linkage from the branch, then the PR head, then the PR body', async () => {
    const readPullRequest = vi.fn(async (_repo: string, n: number) => {
      if (n === 20) return { headRef: 'feat/200-from-head', body: null };
      if (n === 30) return { headRef: 'some-other-branch', body: 'Closes #300' };
      return null;
    });
    const readIssueState = vi.fn(async (_repo: string, n: number) => (n === 100 || n === 200 ? ('closed' as const) : ('open' as const)));
    const out = await deriveInterimSpend(
      OPERATOR,
      deps({
        listRuns: vi.fn(async () => ({
          hasNextPage: false,
          runs: [
            run({ runId: 'r10', requestUsage: { inferenceCost: 10, computeCost: null, platformCost: null }, artifacts: [prArtifact('https://github.com/ima-jin/imajin-ai/pull/10', 'feat/100-x')] }),
            run({ runId: 'r20', requestUsage: { inferenceCost: 20, computeCost: null, platformCost: null }, artifacts: [prArtifact('https://github.com/ima-jin/imajin-ai/pull/20', null)] }),
            run({ runId: 'r30', artifacts: [prArtifact('https://github.com/ima-jin/imajin-ai/pull/30', 'misc')] }),
            run({ runId: 'r40', statusMessage: { message: 'PR #40 opened via gh', errorCode: null, retryable: null } }),
            run({ runId: 'r50' }),
          ],
        })),
        readPullRequest,
        readIssueState,
      }),
      NOW,
    );

    const byId = Object.fromEntries(out.runs.map((r) => [r.runId, r.linkage]));
    expect(byId.r10).toMatchObject({ issue: { repo: 'ima-jin/imajin-ai', number: 100 }, issueVia: 'branch' });
    expect(byId.r20).toMatchObject({ issue: { number: 200 }, issueVia: 'branch', branch: 'feat/200-from-head' });
    expect(byId.r30).toMatchObject({ issue: { number: 300 }, issueVia: 'pr-body' });
    // PR #40 unreadable → no issue, nothing invented; repo defaults to the tracker only for the lookup.
    expect(byId.r40).toMatchObject({ issue: null, issueVia: null, prNumber: 40 });
    expect(byId.r50.issue).toBeNull();
    expect(readPullRequest).toHaveBeenCalledWith('ima-jin/imajin-ai', 40);

    expect(out.githubAvailable).toBe(true);
    expect(out.issues.map((i) => [i.number, i.state])).toEqual([[300, 'open'], [200, 'closed'], [100, 'closed']]);
    expect(out.closedIssueCost).toMatchObject({ closedCount: 2, warpPerIssue: 15, meteredUsdPerIssue: null });
  });

  it('leaves issue state unknown (and cost-per-closed-issue n/a) when GitHub cannot be read', async () => {
    const out = await deriveInterimSpend(
      OPERATOR,
      deps({
        listRuns: vi.fn(async () => ({
          hasNextPage: false,
          runs: [run({ requestUsage: { inferenceCost: 5, computeCost: null, platformCost: null }, artifacts: [prArtifact(null, 'feat/9-z')] })],
        })),
      }),
      NOW,
    );
    expect(out.githubAvailable).toBe(false);
    expect(out.issues).toEqual([{ repo: 'ima-jin/imajin-ai', number: 9, state: 'unknown', runCount: 1, warpTotal: 5, meteredUsd: null }]);
    expect(out.closedIssueCost).toEqual({ closedCount: 0, unknownCount: 1, warpPerIssue: null, meteredUsdPerIssue: null });
  });

  it('returns only the most recent runs for the compact list but aggregates over all', async () => {
    const many = Array.from({ length: 12 }, (_, i) => run({ runId: `r${i}`, artifacts: [prArtifact(null, `feat/${i + 1}-x`)] }));
    const out = await deriveInterimSpend(OPERATOR, deps({ listRuns: vi.fn(async () => ({ runs: many, hasNextPage: false })) }), NOW);
    expect(out.runs).toHaveLength(8);
    expect(out.issues).toHaveLength(12);
  });

  it('stops PR lookups once the per-request GitHub budget is spent', async () => {
    const many = Array.from({ length: 40 }, (_, i) => run({ runId: `r${i}`, statusMessage: { message: `PR #${i + 1}`, errorCode: null, retryable: null } }));
    const readPullRequest = vi.fn(async () => null);
    await deriveInterimSpend(OPERATOR, deps({ listRuns: vi.fn(async () => ({ runs: many, hasNextPage: false })), readPullRequest }), NOW);
    expect(readPullRequest).toHaveBeenCalledTimes(30);
  });
});

describe('default readers', () => {
  it('lists this month\'s runs through the existing Warp reader', async () => {
    mockListAgentRuns.mockResolvedValueOnce({ runs: [run()], hasNextPage: true, nextCursor: 'c' });
    const page = await defaultInterimDeps(OPERATOR).listRuns(OPERATOR, '2026-10-01T00:00:00.000Z');
    expect(mockListAgentRuns).toHaveBeenCalledWith(OPERATOR, { createdAfter: '2026-10-01T00:00:00.000Z', limit: 100 });
    expect(page.hasNextPage).toBe(true);
    expect(page.runs).toHaveLength(1);
  });

  it('reads metered usage grouped by session, skipping empty-session rows', async () => {
    state.rows = [
      { sessionId: 's1', usd: '1.5', turns: '2' },
      { sessionId: 's2', usd: null, turns: '1' },
      { sessionId: null, usd: '9', turns: '9' },
    ];
    const out = await defaultInterimDeps(OPERATOR).meteredBySession(OPERATOR, ['s1', 's2']);
    expect([...out.entries()]).toEqual([
      ['s1', { usd: 1.5, turns: 2 }],
      ['s2', { usd: null, turns: 1 }],
    ]);
  });

  it('does not touch the database with no session ids', async () => {
    const out = await defaultInterimDeps(OPERATOR).meteredBySession(OPERATOR, []);
    expect(out.size).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('reads PR head/body and issue state with the operator\'s own connector, and degrades on error', async () => {
    const d = defaultInterimDeps(OPERATOR);
    mockGetPullRequest.mockResolvedValueOnce({ head: { ref: 'feat/1-x' }, body: 'Closes #1' });
    expect(await d.readPullRequest('o/r', 5)).toEqual({ headRef: 'feat/1-x', body: 'Closes #1' });
    expect(mockGetPullRequest).toHaveBeenCalledWith(OPERATOR, 'o/r', 5);
    mockGetPullRequest.mockResolvedValueOnce({ body: null });
    expect(await d.readPullRequest('o/r', 6)).toEqual({ headRef: null, body: null });
    mockGetPullRequest.mockRejectedValueOnce(new Error('github_no_grant'));
    expect(await d.readPullRequest('o/r', 7)).toBeNull();

    mockGetIssue.mockResolvedValueOnce({ state: 'closed' });
    expect(await d.readIssueState('o/r', 1)).toBe('closed');
    mockGetIssue.mockResolvedValueOnce({ state: 'open' });
    expect(await d.readIssueState('o/r', 2)).toBe('open');
    mockGetIssue.mockRejectedValueOnce(new Error('github_no_credential'));
    expect(await d.readIssueState('o/r', 3)).toBe('unknown');
  });

  it('readInterimSpend wires the default readers end to end', async () => {
    mockListAgentRuns.mockResolvedValueOnce({ runs: [run({ artifacts: [prArtifact(null, 'feat/9-z')] })], hasNextPage: false, nextCursor: null });
    mockGetIssue.mockResolvedValueOnce({ state: 'closed' });
    state.rows = [];
    const out = await readInterimSpend(OPERATOR);
    expect(out.runsAvailable).toBe(true);
    expect(out.issues[0]).toMatchObject({ number: 9, state: 'closed' });
  });
});
