import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSelect, mockCheckSpendCap, mockListRegistrations, state } = vi.hoisted(() => {
  const state = { rows: [] as unknown[] };
  const chain = {
    from: () => chain,
    where: () => chain,
    groupBy: () => Promise.resolve(state.rows),
  };
  return {
    state,
    mockSelect: vi.fn(() => chain),
    mockCheckSpendCap: vi.fn(),
    mockListRegistrations: vi.fn(),
  };
});

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  usageIncurred: { createdAt: 'createdAt', provider: 'provider', costUsd: 'costUsd', principalDid: 'principalDid' },
}));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({ listConnectorRegistrations: mockListRegistrations }));
vi.mock('@/src/lib/inference/spend-cap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/inference/spend-cap')>();
  return { ...actual, checkSpendCap: mockCheckSpendCap };
});
vi.mock('@/src/lib/kernel/connector-registry', () => ({
  CONNECTOR_REGISTRY: [
    { id: 'anthropic', name: 'Anthropic Claude', settings: { route: '/anthropic/api/spend-cap' } },
    { id: 'xai', name: 'xAI', settings: { route: '/xai/api/spend-cap' } },
    { id: 'github', name: 'GitHub' },
    { id: 'warp', name: 'Warp', settings: { route: '/warp/api/environment' } },
  ],
}));

import {
  buildSpendLane,
  capStatus,
  defaultSpendLaneDeps,
  readSpendLane,
  trendDates,
  type SpendLaneDeps,
} from '../spend-lane';

const OPERATOR = 'did:imajin:operator';
const NOW = new Date('2026-10-08T04:45:00Z');

function deps(overrides: Partial<SpendLaneDeps> = {}): SpendLaneDeps {
  return {
    capProviders: () => [
      { id: 'anthropic', name: 'Anthropic Claude' },
      { id: 'xai', name: 'xAI' },
    ],
    listRegistrations: vi.fn(async () => []),
    measureCap: vi.fn(async () => 0),
    dailySpend: vi.fn(async () => []),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
});

describe('trendDates', () => {
  it('returns 7 UTC days ending today, oldest first', () => {
    expect(trendDates(NOW)).toEqual([
      '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
    ]);
  });

  it('crosses month boundaries', () => {
    expect(trendDates(new Date('2026-03-02T23:59:00Z'), 3)).toEqual(['2026-02-28', '2026-03-01', '2026-03-02']);
  });
});

describe('capStatus', () => {
  const cap = { amountUsd: 10, period: 'daily' as const };
  it('classifies spend against the cap', () => {
    expect(capStatus(null, 5)).toEqual({ ratio: null, status: 'uncapped' });
    expect(capStatus(cap, null)).toEqual({ ratio: null, status: 'unknown' });
    expect(capStatus(cap, 2)).toEqual({ ratio: 0.2, status: 'ok' });
    expect(capStatus(cap, 8)).toEqual({ ratio: 0.8, status: 'near' });
    expect(capStatus(cap, 10)).toEqual({ ratio: 1, status: 'over' });
    expect(capStatus(cap, 15).status).toBe('over');
  });
});

describe('buildSpendLane', () => {
  it('builds today/7-day per provider, a zero-filled trend, and cap status', async () => {
    const d = deps({
      dailySpend: vi.fn(async () => [
        { day: '2026-10-08', provider: 'anthropic', usd: 8.5 },
        { day: '2026-10-07', provider: 'anthropic', usd: 1 },
        { day: '2026-10-08', provider: 'xai', usd: 0.25 },
        { day: '2026-10-08', provider: 'claude-code', usd: 2 },
        { day: '2026-09-01', provider: 'xai', usd: 99 }, // outside the trend window: ignored for the trend
      ]),
      listRegistrations: vi.fn(async () => [
        { id: 'conn-anthropic', provider: 'anthropic', spendCap: { amountUsd: 10, period: 'daily' } },
        { id: 'conn-xai', provider: 'xai', spendCap: { amountUsd: 100, period: 'monthly' } },
        { id: 'conn-github', provider: 'github', spendCap: { amountUsd: 5, period: 'daily' } }, // no cap route → ignored
        { id: 'conn-none', provider: 'anthropic-bad', spendCap: { amountUsd: -1, period: 'daily' } },
      ]),
      measureCap: vi.fn(async (id: string) => (id === 'conn-anthropic' ? 9 : 25)),
    });

    const lane = await buildSpendLane(OPERATOR, d, NOW);

    expect(lane.currency).toBe('USD');
    expect(lane.generatedAt).toBe(NOW.toISOString());
    expect(lane.trend.map((t) => t.totalUsd)).toEqual([0, 0, 0, 0, 0, 1, 10.75]);
    expect(lane.todayUsd).toBe(10.75);
    expect(lane.weekUsd).toBe(11.75);

    // sorted: near cap first, then ok, then uncapped
    expect(lane.providers.map((p) => [p.provider, p.status])).toEqual([
      ['anthropic', 'near'],
      ['xai', 'ok'],
      ['claude-code', 'uncapped'],
    ]);
    const anthropic = lane.providers[0];
    expect(anthropic).toMatchObject({
      name: 'Anthropic Claude',
      todayUsd: 8.5,
      weekUsd: 9.5,
      cap: { amountUsd: 10, period: 'daily' },
      periodSpentUsd: 9,
      ratio: 0.9,
    });
    expect(lane.providers[2]).toMatchObject({ name: 'claude-code', cap: null, periodSpentUsd: null });
  });

  it('lists a capped provider even with no spend, and marks an unmeasurable one unknown', async () => {
    const lane = await buildSpendLane(
      OPERATOR,
      deps({
        listRegistrations: vi.fn(async () => [{ id: 'c1', provider: 'xai', spendCap: { amountUsd: 5, period: 'total' } }]),
        measureCap: vi.fn(async () => null),
      }),
      NOW,
    );
    expect(lane.providers).toEqual([
      { provider: 'xai', name: 'xAI', todayUsd: 0, weekUsd: 0, cap: { amountUsd: 5, period: 'total' }, periodSpentUsd: null, ratio: null, status: 'unknown' },
    ]);
    expect(lane.todayUsd).toBe(0);
  });

  it('ranks over-cap first and breaks ties by today\'s spend then name', async () => {
    const lane = await buildSpendLane(
      OPERATOR,
      deps({
        dailySpend: vi.fn(async () => [
          { day: '2026-10-08', provider: 'b-ext', usd: 1 },
          { day: '2026-10-08', provider: 'a-ext', usd: 1 },
          { day: '2026-10-08', provider: 'c-ext', usd: 3 },
          { day: '2026-10-08', provider: 'xai', usd: 1 },
        ]),
        listRegistrations: vi.fn(async () => [{ id: 'cx', provider: 'xai', spendCap: { amountUsd: 1, period: 'daily' } }]),
        measureCap: vi.fn(async () => 1),
      }),
      NOW,
    );
    expect(lane.providers.map((p) => p.provider)).toEqual(['xai', 'c-ext', 'a-ext', 'b-ext']);
    expect(lane.providers[0].status).toBe('over');
  });

  it('queries the 7-day UTC window for the principal', async () => {
    const dailySpend = vi.fn(async () => []);
    await buildSpendLane(OPERATOR, deps({ dailySpend }), NOW);
    expect(dailySpend).toHaveBeenCalledWith(OPERATOR, new Date('2026-10-02T00:00:00.000Z'), new Date('2026-10-09T00:00:00.000Z'));
  });
});

describe('default readers', () => {
  it('enumerates only registry entries that expose a /spend-cap route', () => {
    expect(defaultSpendLaneDeps.capProviders()).toEqual([
      { id: 'anthropic', name: 'Anthropic Claude' },
      { id: 'xai', name: 'xAI' },
    ]);
  });

  it('measures the cap with the kernel\'s own enforcement check', async () => {
    mockCheckSpendCap.mockResolvedValueOnce({ exceeded: false, cap: { amountUsd: 1, period: 'daily' }, spentUsd: 0.4 });
    expect(await defaultSpendLaneDeps.measureCap('c', { amountUsd: 1, period: 'daily' })).toBe(0.4);
    mockCheckSpendCap.mockResolvedValueOnce(undefined);
    expect(await defaultSpendLaneDeps.measureCap('c', { amountUsd: 1, period: 'daily' })).toBeNull();
  });

  it('reads daily spend per provider from usage.incurred (null cost → 0)', async () => {
    state.rows = [
      { day: '2026-10-08', provider: 'xai', usd: '1.5' },
      { day: '2026-10-08', provider: 'openai', usd: null },
    ];
    const rows = await defaultSpendLaneDeps.dailySpend(OPERATOR, new Date(0), new Date(1));
    expect(rows).toEqual([
      { day: '2026-10-08', provider: 'xai', usd: 1.5 },
      { day: '2026-10-08', provider: 'openai', usd: 0 },
    ]);
  });

  it('readSpendLane runs end to end on the default readers', async () => {
    state.rows = [{ day: new Date().toISOString().slice(0, 10), provider: 'xai', usd: '2' }];
    mockListRegistrations.mockResolvedValueOnce([]);
    const lane = await readSpendLane(OPERATOR);
    expect(lane.providers[0]).toMatchObject({ provider: 'xai', todayUsd: 2, status: 'uncapped' });
  });
});
