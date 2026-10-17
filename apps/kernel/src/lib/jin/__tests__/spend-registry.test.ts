import { beforeEach, describe, it, expect, vi } from 'vitest';
const { sql, listRuns, getIssue, getPullRequest, select, rows } = vi.hoisted(() => {
  const rows = { value: [] as unknown[] };
  const chain = { from: () => chain, where: () => chain, groupBy: () => Promise.resolve(rows.value) };
  return {
    sql: vi.fn(), listRuns: vi.fn(), getIssue: vi.fn(), getPullRequest: vi.fn(),
    select: vi.fn(() => chain), rows,
  };
});
vi.mock('@/src/db', () => ({
  db: { select },
  usageIncurred: { sessionId: 'sessionId', costUsd: 'costUsd', principalDid: 'principalDid' },
}));
vi.mock('@/src/lib/warp/dispatch', () => ({ listAgentRuns: listRuns }));
vi.mock('@/src/lib/github/connector', () => ({ getIssue, getPullRequest }));
vi.mock('@/src/lib/github/bug-import', () => ({ BUG_TRACKER_REPO: 'ima-jin/imajin-ai' }));
vi.mock('@imajin/db', () => ({ getClient: () => sql }));
import { buildRegistrySpend, githubSubject, readRegistryLaneSpend, type RegistrySpendDeps } from '../spend-registry';
import type { RegistryRunCost } from '@/src/lib/loops/spend';
import type { WarpAgentRun } from '@/src/lib/warp/dispatch';

const principal = 'did:imajin:owner';
const now = new Date('2026-10-16T12:00:00Z');
beforeEach(() => {
  vi.clearAllMocks();
  sql.mockReset();
  rows.value = [];
});
function registered(overrides: Partial<RegistryRunCost> = {}): RegistryRunCost {
  return {
    runId: 'registered', loopId: 'loop1',
    refs: { runId: 'registered', issue: 'https://github.com/o/r/issues/2290', pr: 'o/r#2836' },
    summary: 'signed subject', state: 'succeeded',
    startedAt: '2026-10-03T00:00:00Z', lastSeenAt: '2026-10-04T00:00:00Z',
    metered: { usd: 5, turns: 2 }, ...overrides,
  };
}
function warp(runId: string): WarpAgentRun {
  return {
    runId, sessionId: null, conversationId: null, requestUsage: null,
    title: 'legacy', state: 'SUCCEEDED', createdAt: '2026-10-02T00:00:00Z',
    artifacts: [{ artifactType: 'PULL_REQUEST', data: { url: 'https://github.com/o/r/pull/3', branch: 'feat/2290-legacy' } }],
    statusMessage: null,
  } as WarpAgentRun;
}
function deps(runs = [registered()]): RegistrySpendDeps {
  return {
    readRegistry: vi.fn(async () => ({
      currency: 'USD' as const, windowFrom: '', windowTo: '', runs,
      issues: [], prs: [{ ref: 'o/r#2836', runCount: 1, meteredUsd: 5 }],
    })),
    registered: vi.fn(async () => new Set(['registered'])),
    interim: {
      listRuns: vi.fn(async () => ({ runs: [warp('registered'), warp('legacy')], hasNextPage: false })),
      meteredBySession: vi.fn(async () => new Map([['legacy', { usd: 2, turns: 1 }]])),
      readPullRequest: vi.fn(async () => null),
      readIssueState: vi.fn(async () => 'closed' as const),
    },
  };
}
describe('registry-first Spend lane', () => {
  it('uses signed subjects/costs, derives only absent loops, and aggregates before compact slicing', async () => {
    const d = deps();
    const result = await buildRegistrySpend(principal, d, now);
    expect(d.readRegistry).toHaveBeenCalledWith(principal, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    expect(d.registered).toHaveBeenCalledWith(principal, ['registered', 'legacy']);
    expect(d.interim.meteredBySession).toHaveBeenCalledWith(principal, ['legacy']);
    expect(d.interim.readPullRequest).not.toHaveBeenCalled();
    expect(result.runs[0]).toMatchObject({ runId: 'registered', metered: { usd: 5 }, linkage: { issueVia: 'registry', issue: { repo: 'o/r', number: 2290 } } });
    expect(result.runs).toHaveLength(2);
    expect(result.closedIssueCost.meteredUsdPerIssue).toBe(7);
    expect(result.prs).toEqual([{ ref: 'o/r#2836', runCount: 1, meteredUsd: 5 }]);
    expect(result.label).toContain('1 legacy');
  });
  it('reuses successful and unknown fallback issue states instead of repeating connector reads', async () => {
    const d = deps();
    await buildRegistrySpend(principal, d, now);
    expect(d.interim.readIssueState).toHaveBeenCalledOnce();
    expect(d.interim.readIssueState).toHaveBeenCalledWith('o/r', 2290);
    vi.mocked(d.interim.readIssueState).mockClear().mockRejectedValue(new Error('no grant'));
    const result = await buildRegistrySpend(principal, d, now);
    expect(d.interim.readIssueState).toHaveBeenCalledOnce();
    expect(d.interim.readIssueState).toHaveBeenCalledWith('o/r', 2290);
    expect(result.githubAvailable).toBe(false);
  });
  it('shares one 30-issue request budget across fallback and unbounded registry history', async () => {
    const runs = Array.from({ length: 40 }, (_, i) => registered({
      runId: `r${i}`, refs: { issue: `o/r#${i + 1}` },
    }));
    const d = deps(runs);
    const result = await buildRegistrySpend(principal, d, now);
    expect(d.interim.readIssueState).toHaveBeenCalledTimes(30);
    expect(result.issues).toHaveLength(41);
    expect(result.issues.filter((issue) => issue.state === 'unknown')).toHaveLength(11);
    expect(result.issues.find((issue) => issue.number === 2290)?.state).toBe('closed');
  });
  it.each([false, true])('does not present partial-known issue USD as a complete total (unknown first: %s)', async (unknownFirst) => {
    const known = registered();
    const unknown = registered({ runId: 'unknown', metered: null });
    const d = deps(unknownFirst ? [unknown, known] : [known, unknown]);
    vi.mocked(d.interim.listRuns).mockResolvedValue({ runs: [], hasNextPage: false });
    const result = await buildRegistrySpend(principal, d, now);
    expect(result.issues[0].meteredUsd).toBeNull();
    expect(result.closedIssueCost.meteredUsdPerIssue).toBeNull();
  });
  it('keeps registry runs and closed issue costs when Warp is unavailable', async () => {
    const d = deps();
    vi.mocked(d.interim.listRuns).mockRejectedValue(new Error('no Warp key'));
    const result = await buildRegistrySpend(principal, d, now);
    expect(result.runsAvailable).toBe(true);
    expect(result.runs[0].metered?.usd).toBe(5);
    expect(result.closedIssueCost.meteredUsdPerIssue).toBe(5);
    expect(result.label).not.toContain('legacy');
  });
  it('does not heuristically repair registry runs with missing subject/cost', async () => {
    const d = deps([registered({ refs: { runId: 'registered' }, metered: null })]);
    vi.mocked(d.interim.listRuns).mockResolvedValue({ runs: [warp('registered')], hasNextPage: false });
    const result = await buildRegistrySpend(principal, d, now);
    expect(result.runs[0]).toMatchObject({ attribution: 'unattributed', linkage: { issue: null } });
    expect(d.interim.meteredBySession).toHaveBeenCalledWith(principal, []);
    expect(result.issues).toEqual([]);
  });
  it('supports pure legacy history and preserves unknown closure states', async () => {
    const d = deps([]);
    vi.mocked(d.registered).mockResolvedValue(new Set());
    vi.mocked(d.interim.readIssueState).mockRejectedValue(new Error('unavailable'));
    // The default connector absorbs GitHub errors; injected reader keeps that contract.
    d.interim.readIssueState = vi.fn(async () => 'unknown');
    const result = await buildRegistrySpend(principal, d, now);
    expect(result.runs).toHaveLength(2);
    expect(result.githubAvailable).toBe(false);
    expect(result.closedIssueCost.closedCount).toBe(0);
  });
  it('fails closed on registry or membership outage, not a global interim fallback', async () => {
    const d = deps();
    vi.mocked(d.readRegistry).mockRejectedValueOnce(new Error('registry unavailable'));
    await expect(buildRegistrySpend(principal, d, now)).rejects.toThrow('registry unavailable');
    expect(d.interim.listRuns).not.toHaveBeenCalled();
    vi.mocked(d.registered).mockRejectedValue(new Error('membership unavailable'));
    await expect(buildRegistrySpend(principal, d, now)).rejects.toThrow('membership unavailable');
    expect(d.interim.meteredBySession).not.toHaveBeenCalled();
  });
  it('keeps null costs unknown, zero metered, and all issue totals beyond recent eight', async () => {
    const runs = Array.from({ length: 10 }, (_, i) => registered({
      runId: `r${i}`, metered: i === 0 ? { usd: null, turns: 1 } : { usd: 0, turns: 1 },
    }));
    const d = deps(runs);
    vi.mocked(d.interim.listRuns).mockResolvedValue({ runs: [], hasNextPage: false });
    const result = await buildRegistrySpend(principal, d, now);
    expect(result.runs).toHaveLength(8);
    expect(result.runs[0].attribution).toBe('unattributed');
    expect(result.runs[1].attribution).toBe('metered');
    expect(result.issues[0]).toMatchObject({ runCount: 10, meteredUsd: null });
    expect(result.closedIssueCost.meteredUsdPerIssue).toBeNull();
  });
});

describe('default registry Spend entrypoint', () => {
  it('wires principal-scoped registry membership and excludes registry-owned sessions from legacy metering', async () => {
    const registeredRow = {
      run_id: 'registered', loop_id: 'loop1',
      refs: { runId: 'registered', issue: 'o/r#2290' },
      summary: 'signed subject', state: 'succeeded',
      started_at: '2026-10-03T00:00:00Z', last_seen_at: '2026-10-04T00:00:00Z', usd: '5', turns: '2',
    };
    sql.mockResolvedValueOnce([registeredRow])
      .mockResolvedValueOnce([{ run_id: 'registered' }])
      .mockResolvedValueOnce([{ session_id: 'legacy' }]);
    listRuns.mockResolvedValueOnce({
      runs: [warp('registered'), { ...warp('legacy'), sessionId: 'registry-session' }], hasNextPage: false,
    });
    rows.value = [{ sessionId: 'legacy', usd: '2', turns: '1' }];
    getIssue.mockResolvedValue({ state: 'closed' });
    const result = await readRegistryLaneSpend(principal);
    expect(result.runs.map((run) => run.runId)).toEqual(['registered', 'legacy']);
    expect(result.closedIssueCost.meteredUsdPerIssue).toBe(7);
    expect(sql.mock.calls[1].slice(1)).toEqual([['registered', 'legacy'], principal]);
    expect(sql.mock.calls[2].slice(1)).toEqual([['legacy', 'registry-session'], principal, principal]);
    expect(select).toHaveBeenCalledOnce();
    expect(getIssue).toHaveBeenCalledOnce();
    expect(getIssue).toHaveBeenCalledWith(principal, 'o/r', 2290);
  });
  it('keeps registry data available when the default Warp reader fails', async () => {
    sql.mockResolvedValueOnce([]);
    listRuns.mockRejectedValueOnce(new Error('Warp unavailable'));
    const result = await readRegistryLaneSpend(principal);
    expect(result.runs).toEqual([]);
    expect(sql).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
  });
});
describe('explicit signed GitHub subject refs', () => {
  it('accepts qualified refs and rejects unknown or unsafe refs without guessing', () => {
    expect(githubSubject('o/r#3', 'issue')).toEqual({ repo: 'o/r', number: 3 });
    expect(githubSubject('https://github.com/o/r/pull/3', 'pr')).toEqual({ repo: 'o/r', number: 3 });
    for (const ref of [undefined, '#3', 'feat/3-slug', 'javascript:alert(1)', 'o/r#0', 'o/r#99999999999999999999']) {
      expect(githubSubject(ref, 'issue')).toBeNull();
    }
  });
});
