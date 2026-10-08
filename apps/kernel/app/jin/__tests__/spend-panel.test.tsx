// @vitest-environment jsdom
/**
 * Component tests for the /jin Spend lane (#2725): operator gate (a
 * non-operator sees nothing), provider spend vs cap with near/over flags,
 * the 7-day trend, the INTERIM-labelled run cost + cost-per-closed-issue
 * block, honest "unattributed"/"unknown" states, and a 390px-viewport
 * structural check (no fixed widths / horizontal-scroll classes).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { SpendPanel, formatUsd, formatWarpUnits } from '../spend-panel';
import type { SpendLane, ProviderSpend } from '@/src/lib/jin/spend-lane';
import type { InterimRunCost, InterimSpend } from '@/src/lib/jin/spend-interim-join';

function provider(overrides: Partial<ProviderSpend> = {}): ProviderSpend {
  return {
    provider: 'anthropic',
    name: 'Anthropic Claude',
    todayUsd: 1.5,
    weekUsd: 9,
    cap: { amountUsd: 10, period: 'daily' },
    periodSpentUsd: 1.5,
    ratio: 0.15,
    status: 'ok',
    ...overrides,
  };
}

function lane(overrides: Partial<SpendLane> = {}): SpendLane {
  const dates = ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
  return {
    generatedAt: '2026-10-08T04:45:00.000Z',
    currency: 'USD',
    providers: [provider()],
    trend: dates.map((date, i) => ({ date, totalUsd: i })),
    todayUsd: 6,
    weekUsd: 21,
    ...overrides,
  };
}

function runCost(overrides: Partial<InterimRunCost> = {}): InterimRunCost {
  return {
    runId: 'run-1',
    title: 'Fix the thing',
    state: 'SUCCEEDED',
    createdAt: '2026-10-05T00:00:00Z',
    warp: { inference: 1, compute: 0.5, platform: null, total: 1.5 },
    metered: null,
    attribution: 'warp-reported',
    linkage: { branch: 'feat/2725-x', prUrl: 'https://github.com/ima-jin/imajin-ai/pull/9', prRepo: 'ima-jin/imajin-ai', prNumber: 9, issue: { repo: 'ima-jin/imajin-ai', number: 2725 }, issueVia: 'branch' },
    ...overrides,
  };
}

function interim(overrides: Partial<InterimSpend> = {}): InterimSpend {
  return {
    label: 'interim · derived from Warp runs + branch names (until #2290)',
    windowFrom: '2026-10-01T00:00:00.000Z',
    runsAvailable: true,
    runsTruncated: false,
    githubAvailable: true,
    runs: [runCost()],
    issues: [],
    closedIssueCost: { closedCount: 2, unknownCount: 0, warpPerIssue: 3, meteredUsdPerIssue: 0.5 },
    ...overrides,
  };
}

type Payloads = {
  spend?: { isOperator: boolean; spend: SpendLane | null } | 'fail' | 'throw';
  runs?: { isOperator: boolean; interim: InterimSpend | null } | 'fail' | 'throw';
};

function installFetch({ spend = { isOperator: true, spend: lane() }, runs = { isOperator: true, interim: interim() } }: Payloads = {}) {
  const spy = vi.fn((url: string) => {
    const payload = url.includes('/jin/api/spend/runs') ? runs : spend;
    if (payload === 'throw') return Promise.reject(new Error('offline'));
    if (payload === 'fail') return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    return Promise.resolve({ ok: true, status: 200, json: async () => payload } as unknown as Response);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('formatters', () => {
  it('formats USD with sub-dollar precision and Warp units as reported', () => {
    expect(formatUsd(12.3456)).toBe('$12.35');
    expect(formatUsd(0.5)).toBe('$0.5000');
    expect(formatWarpUnits(1.5)).toBe('1.50 units');
  });
});

describe('SpendPanel operator gate', () => {
  it('renders nothing for a non-operator — no header, no data, no interim block', async () => {
    const spy = installFetch({ spend: { isOperator: false, spend: null }, runs: { isOperator: false, interim: null } });
    const { container } = render(<SpendPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe('');
    expect(screen.queryByText('Spend')).toBeNull();
  });

  it('renders nothing when the spend request is rejected (e.g. 401)', async () => {
    const spy = installFetch({ spend: 'fail', runs: 'fail' });
    const { container } = render(<SpendPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(container.innerHTML).toBe('');
  });
});

describe('SpendPanel provider block', () => {
  it('shows today per provider, the 7-day trend and totals', async () => {
    installFetch({ runs: { isOperator: true, interim: null } });
    render(<SpendPanel />);

    expect(await screen.findByText('Spend')).toBeDefined();
    expect(screen.getByTestId('spend-today-total').textContent).toBe('$6.00');
    expect(screen.getByTestId('spend-week-total').textContent).toBe('$21.00');
    expect(screen.getAllByTestId('spend-trend-bar')).toHaveLength(7);
    expect(screen.getByRole('img', { name: '7-day spend trend' })).toBeDefined();
    expect(screen.getByTestId('spend-provider-today').textContent).toBe('$1.50');
    expect(screen.getByText('$1.50 of $10.00 daily cap')).toBeDefined();
  });

  it('flags providers that are close to / at their cap and labels the rest', async () => {
    installFetch({
      spend: {
        isOperator: true,
        spend: lane({
          providers: [
            provider({ provider: 'xai', name: 'xAI', status: 'over', ratio: 1.2, periodSpentUsd: 12 }),
            provider({ provider: 'anthropic', status: 'near', ratio: 0.9, periodSpentUsd: 9 }),
            provider({ provider: 'openai', name: 'OpenAI', status: 'unknown', ratio: null, periodSpentUsd: null }),
            provider({ provider: 'claude-code', name: 'claude-code', status: 'uncapped', cap: null, ratio: null, periodSpentUsd: null }),
          ],
        }),
      },
      runs: { isOperator: true, interim: null },
    });
    render(<SpendPanel />);

    const rows = await screen.findAllByTestId('spend-provider');
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['over', 'near', 'unknown', 'uncapped']);
    expect(within(rows[0]).getByText('at cap')).toBeDefined();
    expect(within(rows[1]).getByText('near cap')).toBeDefined();
    expect(within(rows[2]).getByText('spend unmeasured of $10.00 daily cap')).toBeDefined();
    expect(within(rows[3]).getByText('no cap')).toBeDefined();
    expect(within(rows[3]).queryByRole('progressbar')).toBeNull();
    // bar fill is clamped at 100% even when spend exceeds the cap
    expect(within(rows[0]).getByRole('progressbar').getAttribute('value')).toBe('100');
    expect(within(rows[1]).getByRole('progressbar').getAttribute('value')).toBe('90');
  });

  it('shows an empty state with no providers and a flat trend', async () => {
    installFetch({
      spend: { isOperator: true, spend: lane({ providers: [], todayUsd: 0, weekUsd: 0, trend: lane().trend.map((t) => ({ ...t, totalUsd: 0 })) }) },
      runs: { isOperator: true, interim: null },
    });
    render(<SpendPanel />);
    expect(await screen.findByText('No provider spend or caps in the last 7 days.')).toBeDefined();
  });

  it('surfaces a load error without hiding an already-loaded lane, and refreshes on tap', async () => {
    const spy = installFetch({ runs: { isOperator: true, interim: null } });
    render(<SpendPanel />);
    await screen.findByText('Spend');

    installFetch({ spend: 'fail', runs: { isOperator: true, interim: null } });
    fireEvent.click(screen.getByRole('button', { name: /refresh/ }));
    expect(await screen.findByText('Failed to load spend (500)')).toBeDefined();
    expect(screen.getByTestId('spend-today-total')).toBeDefined();
    expect(spy).toHaveBeenCalled();

    installFetch({ spend: 'throw', runs: 'throw' });
    fireEvent.click(screen.getByRole('button', { name: /refresh/ }));
    expect(await screen.findByText('Network error loading spend')).toBeDefined();
  });

  it('polls the provider block on an interval and stops on unmount', async () => {
    const intervals: Array<() => void> = [];
    const clear = vi.fn();
    vi.stubGlobal('setInterval', vi.fn((cb: () => void) => { intervals.push(cb); return 7 as unknown as ReturnType<typeof setInterval>; }));
    vi.stubGlobal('clearInterval', clear);
    const spy = installFetch({ runs: { isOperator: true, interim: null } });
    const { unmount } = render(<SpendPanel />);
    await screen.findByText('Spend');
    const before = spy.mock.calls.length;
    intervals[0]();
    await waitFor(() => expect(spy.mock.calls).toHaveLength(before + 1));
    expect(spy.mock.calls.at(-1)?.[0]).toBe('/jin/api/spend');
    unmount();
    expect(clear).toHaveBeenCalledWith(7);
  });
});

describe('SpendPanel interim block', () => {
  it('labels the derivation INTERIM and shows cost per closed issue in each unit separately', async () => {
    installFetch();
    render(<SpendPanel />);

    expect((await screen.findByTestId('spend-interim-label')).textContent).toContain('interim');
    expect(screen.getByTestId('spend-interim-label').textContent).toContain('#2290');
    const closed = screen.getByTestId('spend-closed-issue-cost').textContent ?? '';
    expect(closed).toContain('$0.5000 metered');
    expect(closed).toContain('3.00 units Warp-reported');
    expect(closed).toContain('2 closed this month');
  });

  it('shows the per-run cost and, on tap, what it cost — Warp-reported breakdown + links', async () => {
    installFetch({
      runs: {
        isOperator: true,
        interim: interim({
          runs: [
            runCost({ runId: 'm', title: 'metered run', attribution: 'metered', metered: { usd: 2, turns: 1 } }),
            runCost({ runId: 'w', title: 'warp run' }),
            runCost({ runId: 'u', title: 'mystery', warp: null, attribution: 'unattributed', linkage: { branch: null, prUrl: null, prRepo: null, prNumber: null, issue: null, issueVia: null } }),
          ],
        }),
      },
    });
    render(<SpendPanel />);

    const rows = await screen.findAllByTestId('spend-run');
    expect(rows.map((r) => within(r).getByTestId('spend-run-cost').textContent)).toEqual(['$2.00 metered', '1.50 units Warp', 'unattributed']);

    fireEvent.click(within(rows[1]).getByRole('button'));
    const detail = within(rows[1]).getByTestId('spend-run-detail');
    expect(detail.textContent).toContain('Warp-reported: inference 1 · compute 0.5 · platform — (units)');
    expect(detail.textContent).toContain('feat/2725-x');
    expect(detail.textContent).toContain('issue #2725 (via branch)');
    expect(within(detail).getByRole('link', { name: 'PR #9' }).getAttribute('href')).toBe('https://github.com/ima-jin/imajin-ai/pull/9');

    fireEvent.click(within(rows[0]).getByRole('button'));
    expect(within(rows[0]).getByTestId('spend-run-detail').textContent).toContain('Metered: $2.00 over 1 turn');

    fireEvent.click(within(rows[2]).getByRole('button'));
    expect(within(rows[2]).getByTestId('spend-run-detail').textContent).toContain('No cost resolved for this run.');

    fireEvent.click(within(rows[1]).getByRole('button'));
    expect(within(rows[1]).queryByTestId('spend-run-detail')).toBeNull();
  });

  it('never invents a number: unknown issue state reads n/a, unresolvable runs read unattributed', async () => {
    installFetch({
      runs: {
        isOperator: true,
        interim: interim({
          githubAvailable: false,
          closedIssueCost: { closedCount: 0, unknownCount: 3, warpPerIssue: null, meteredUsdPerIssue: null },
        }),
      },
    });
    render(<SpendPanel />);
    const text = (await screen.findByTestId('spend-closed-issue-cost')).textContent ?? '';
    expect(text).toContain('n/a');
    expect(text).toContain('GitHub read not available');
    expect(text).toContain('3 linked issues unresolved');
  });

  it('says so when GitHub is readable but nothing linked is closed yet', async () => {
    installFetch({
      runs: { isOperator: true, interim: interim({ closedIssueCost: { closedCount: 0, unknownCount: 0, warpPerIssue: null, meteredUsdPerIssue: null } }) },
    });
    render(<SpendPanel />);
    expect((await screen.findByTestId('spend-closed-issue-cost')).textContent).toContain('no linked issue is closed yet');
  });

  it('reads "unattributed" when closed issues exist but carry no cost', async () => {
    installFetch({
      runs: { isOperator: true, interim: interim({ closedIssueCost: { closedCount: 1, unknownCount: 0, warpPerIssue: null, meteredUsdPerIssue: null } }) },
    });
    render(<SpendPanel />);
    expect((await screen.findByTestId('spend-closed-issue-cost')).textContent).toContain('unattributed');
  });

  it('degrades when Warp runs are unavailable, with no run list or numbers', async () => {
    installFetch({ runs: { isOperator: true, interim: interim({ runsAvailable: false, runs: [], issues: [] }) } });
    render(<SpendPanel />);
    expect(await screen.findByTestId('spend-runs-unavailable')).toBeDefined();
    expect(screen.queryByTestId('spend-run')).toBeNull();
  });

  it('handles an empty month and a truncated page', async () => {
    installFetch({ runs: { isOperator: true, interim: interim({ runs: [], runsTruncated: true }) } });
    render(<SpendPanel />);
    expect(await screen.findByText('No Warp runs this month.')).toBeDefined();
    expect(screen.getByText(/More runs exist than were read/)).toBeDefined();
  });

  it('keeps the provider block when the interim read fails or is refused', async () => {
    installFetch({ runs: 'fail' });
    const { unmount } = render(<SpendPanel />);
    await screen.findByText('Spend');
    expect(screen.queryByTestId('spend-interim')).toBeNull();
    unmount();

    installFetch({ runs: 'throw' });
    render(<SpendPanel />);
    await screen.findByText('Spend');
    expect(screen.queryByTestId('spend-interim')).toBeNull();

    cleanup();
    installFetch({ runs: { isOperator: false, interim: interim() } });
    render(<SpendPanel />);
    await screen.findByText('Spend');
    expect(screen.queryByTestId('spend-interim')).toBeNull();
  });
});

describe('SpendPanel at a 390px viewport', () => {
  it('lays out as a single column with no fixed widths or horizontal-scroll classes', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    try {
      installFetch({
        spend: { isOperator: true, spend: lane({ providers: [provider({ name: 'A very long provider display name that must truncate rather than overflow' })] }) },
      });
      const { container } = render(<SpendPanel />);
      await screen.findByTestId('spend-interim');

      const html = container.innerHTML;
      // No horizontal scroll containers, no fixed pixel widths/min-widths, no tables.
      expect(html).not.toMatch(/overflow-x-(auto|scroll)/);
      expect(html).not.toMatch(/\bw-\[\d+px\]/);
      expect(html).not.toMatch(/\bmin-w-\[\d+px\]/);
      expect(container.querySelector('table')).toBeNull();
      // Long text truncates or wraps instead of widening the row.
      const name = screen.getByText(/A very long provider/);
      expect(name.className).toContain('truncate');
      expect(name.className).toContain('min-w-0');
      // The whole lane (trend + provider + interim) is rendered at once.
      expect(screen.getByTestId('spend-trend')).toBeDefined();
      expect(screen.getByTestId('spend-provider')).toBeDefined();
      expect(screen.getByTestId('spend-closed-issue-cost')).toBeDefined();
      expect(window.innerWidth).toBe(390);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: original });
    }
  });
});
