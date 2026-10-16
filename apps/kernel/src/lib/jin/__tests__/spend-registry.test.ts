import { describe, it, expect, vi } from 'vitest';
vi.mock('@/src/db', () => ({ db: {}, usageIncurred: {} }));
vi.mock('@/src/lib/warp/dispatch', () => ({ listAgentRuns: vi.fn() }));
vi.mock('@/src/lib/github/connector', () => ({ getIssue: vi.fn(), getPullRequest: vi.fn() }));
vi.mock('@/src/lib/github/bug-import', () => ({ BUG_TRACKER_REPO: 'ima-jin/imajin-ai' }));
vi.mock('@imajin/db', () => ({ getClient: vi.fn() }));
import { buildRegistrySpend, githubSubject, type RegistrySpendDeps } from '../spend-registry';
import type { RegistryRunCost } from '@/src/lib/loops/spend';
import type { WarpAgentRun } from '@/src/lib/warp/dispatch';

const principal = 'did:imajin:owner';
const now = new Date('2026-10-16T12:00:00Z');
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
    expect(result.issues[0]).toMatchObject({ runCount: 10, meteredUsd: 0 });
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
