import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentRun } from '../../../warp/__tests__/run-fixture';

const { list, sql, json } = vi.hoisted(() => ({
  list: vi.fn(),
  sql: vi.fn(),
  json: vi.fn((value: unknown) => value),
}));
vi.mock('@/src/lib/warp/dispatch', () => ({
  listAgentRuns: list,
  isTerminalRunState: (state: string) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state),
}));
vi.mock('@imajin/db', () => ({ getClient: () => Object.assign(sql, { json }) }));

import {
  DEFAULT_WARP_CREDIT_RATE, WARP_BILLED_SINCE, WARP_CREDIT_RATE_CONFIG,
  ingestWarpBilledUsage, readWarpBilledRuns, warpBilledId,
} from '../warp';
import { WarpApiError } from '../../../warp/errors';
import { BillingApiError } from '../types';

const OWNER = 'did:imajin:owner';
const NOW = new Date('2026-10-21T12:00:00Z');
const run = (overrides: Parameters<typeof makeAgentRun>[0] = {}) => makeAgentRun({
  createdAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T11:00:00Z',
  modelId: 'claude-sonnet', requestUsage: { inferenceCost: 6000, computeCost: 400, platformCost: 100 },
  ...overrides,
});
const page = (runs = [run()], nextCursor: string | null = null) => ({
  runs, nextCursor, hasNextPage: nextCursor !== null,
});

beforeEach(() => {
  vi.resetAllMocks();
  json.mockImplementation((value: unknown) => value);
  sql.mockResolvedValue([]);
  list.mockResolvedValue(page());
});

describe('readWarpBilledRuns', () => {
  it('paginates every run with the dispatch client and includes failed/cancelled children without environments', async () => {
    list.mockResolvedValueOnce(page([run()], 'page-two'))
      .mockResolvedValueOnce(page([
        run({ runId: 'child', parentRunId: 'parent', environmentId: null, state: 'FAILED' }),
        run({ runId: 'cancelled', state: 'CANCELLED' }),
        run({ runId: 'blocked', state: 'BLOCKED' }),
        run({ runId: 'queued', state: 'QUEUED' }),
      ]));
    const lines = await readWarpBilledRuns(OWNER, NOW);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ runId: 'child', parentRunId: 'parent', credits: 6500 });
    expect(list.mock.calls).toEqual([
      [OWNER, { createdAfter: WARP_BILLED_SINCE, limit: 500 }],
      [OWNER, { createdAfter: WARP_BILLED_SINCE, limit: 500, cursor: 'page-two' }],
    ]);
  });

  it('enforces cutoff locally, ignores unknown usage and accepts reported zero and null child components', async () => {
    list.mockResolvedValue(page([
      run({ runId: 'old', createdAt: '2026-10-18T23:59:59.999Z' }),
      run({ runId: 'cutoff', createdAt: WARP_BILLED_SINCE }),
      run({ runId: 'future', createdAt: NOW.toISOString() }),
      run({ runId: 'invalid', createdAt: null }),
      run({ runId: 'unknown', requestUsage: null }),
      run({ runId: 'unknown-components', requestUsage: { inferenceCost: null, computeCost: null, platformCost: null } }),
      run({ runId: 'zero', requestUsage: { inferenceCost: 0, computeCost: 0, platformCost: 0 } }),
      run({ runId: 'child', requestUsage: { inferenceCost: 4, computeCost: null, platformCost: null } }),
    ]));
    expect((await readWarpBilledRuns(OWNER, NOW)).map((line) => [line.runId, line.credits]))
      .toEqual([['cutoff', 6500], ['zero', 0], ['child', 4]]);
  });

  it('deduplicates overlapping pages by run ID and keeps greatest cumulative usage', async () => {
    list.mockResolvedValueOnce(page([run()], 'two'))
      .mockResolvedValueOnce(page([run({ requestUsage: { inferenceCost: 7000, computeCost: 0, platformCost: 0 } }), run()]));
    expect(await readWarpBilledRuns(OWNER, NOW)).toMatchObject([{ credits: 7000 }]);
  });

  it.each([null, 'repeat'])('fails safely rather than silently truncating broken pagination (%s)', async (cursor) => {
    list.mockResolvedValue({ runs: [], hasNextPage: true, nextCursor: cursor });
    await expect(readWarpBilledRuns(OWNER, NOW)).rejects.toThrow('Warp billed usage unavailable');
    expect(list.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid credits (%s)', async (inferenceCost) => {
    list.mockResolvedValue(page([run({ requestUsage: { inferenceCost, computeCost: 0, platformCost: 0 } })]));
    await expect(readWarpBilledRuns(OWNER, NOW)).rejects.toThrow('Warp billed usage unavailable');
  });

  it('strips arbitrary run metadata and safely normalizes invalid updated timestamps', async () => {
    list.mockResolvedValue(page([run({ title: 'private-prompt-value', updatedAt: 'invalid' })]));
    const lines = await readWarpBilledRuns(OWNER, NOW);
    expect(JSON.stringify(lines)).not.toContain('private-prompt-value');
    expect(lines[0].updatedAt).toEqual(lines[0].createdAt);
  });

  it.each([401, 403, 500])('never exposes provider message/detail in a %s failure', async (status) => {
    list.mockRejectedValue(new WarpApiError('provider-sensitive-echo', { status, detail: 'provider-sensitive-echo' }));
    const error = await readWarpBilledRuns(OWNER, NOW).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BillingApiError);
    expect(error).toMatchObject({ status, message: 'Warp billed usage unavailable' });
    expect(String(error)).not.toContain('provider-sensitive-echo');
  });
});

describe('ingestWarpBilledUsage', () => {
  it('uses stable principal/run identity, not a run ID in model', () => {
    expect(warpBilledId(OWNER, 'run')).toBe(warpBilledId(OWNER, 'run'));
    expect(warpBilledId(OWNER, 'run')).not.toBe(warpBilledId('other', 'run'));
    expect(warpBilledId(OWNER, 'run')).not.toBe(warpBilledId(OWNER, 'other'));
  });

  it('stores default USD100/6500 rate on each sanitized line, preserving actual model and timestamps', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'written' }]);
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(1);
    expect(sql.mock.calls[0][1]).toBe(WARP_CREDIT_RATE_CONFIG);
    expect(json).toHaveBeenCalledWith({
      runId: run().runId, parentRunId: null, requestUsage: run().requestUsage,
      credits: 6500, creditRate: DEFAULT_WARP_CREDIT_RATE,
    });
    const [strings, ...values] = sql.mock.calls[1];
    const text = strings.join('?');
    expect(text).toContain("'warp', 'api', 'USD'");
    expect(values).toContain('claude-sonnet');
    expect(values).toContain(warpBilledId(OWNER, run().runId));
    expect(values).toContainEqual(new Date(run().createdAt!));
    expect(values).toContainEqual(new Date(run().updatedAt!));
    expect(text).toContain('ON CONFLICT (id)');
    expect(text).toContain("jsonb_set(EXCLUDED.raw, '{creditRate}', usage.billed.raw->'creditRate')");
    expect(text).toContain("(usage.billed.raw->'creditRate'->>'usd')::numeric");
    expect(text).toContain("(usage.billed.raw->'creditRate'->>'credits')::numeric");
    expect(text).toContain("(EXCLUDED.raw->>'credits')::numeric > (usage.billed.raw->>'credits')::numeric");
  });

  it('uses configured rate for new rows but never puts it into conflict growth calculation', async () => {
    sql.mockResolvedValueOnce([{ value: { usd: 50, credits: 6500 } }])
      .mockResolvedValueOnce([{ id: 'written' }]);
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(1);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ creditRate: { usd: 50, credits: 6500 } }));
    const text = sql.mock.calls[1][0].join('?').split('DO UPDATE SET')[1];
    expect(text).not.toContain('EXCLUDED.billed_usd');
    expect(text).toContain("usage.billed.raw->'creditRate'");
  });

  it('returns zero on unchanged/stale runs, without unconditional fetched_at/raw updates', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(0);
  });

  it('does not touch storage if no terminal usage is known', async () => {
    list.mockResolvedValue(page([]));
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(0);
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([{ usd: 0, credits: 6500 }, { usd: 100, credits: -1 }, 'invalid'])('rejects invalid config safely (%j)', async (value) => {
    sql.mockResolvedValueOnce([{ value }]);
    await expect(ingestWarpBilledUsage(OWNER, NOW)).rejects.toThrow('Warp billed usage unavailable');
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transport, credential and storage failures', async () => {
    list.mockRejectedValueOnce(new Error('provider-sensitive-echo'));
    await expect(ingestWarpBilledUsage(OWNER, NOW)).rejects.toThrow('Warp billed usage unavailable');
    sql.mockRejectedValueOnce(new Error('provider-sensitive-echo'));
    await expect(ingestWarpBilledUsage(OWNER, NOW)).rejects.toThrow('Warp billed usage unavailable');
  });
});
