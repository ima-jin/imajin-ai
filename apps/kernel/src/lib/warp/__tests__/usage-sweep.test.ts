import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentRun } from './run-fixture';

const { sql, meter, getRun, list, log } = vi.hoisted(() => ({
  sql: vi.fn(), meter: vi.fn(), getRun: vi.fn(), list: vi.fn(),
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@imajin/db', () => ({ getClient: () => sql }));
vi.mock('@imajin/logger', () => ({ createLogger: () => log }));
vi.mock('../dispatch', () => ({ getAgentRun: getRun, listAgentRuns: list }));
vi.mock('../../usage/warp-incurred', () => ({
  recordWarpRunUsage: meter, WARP_INCURRED_SINCE: '2026-10-19T00:00:00.000Z',
}));
import { sweepWarpIncurredUsage } from '../usage-sweep';

const OWNER = 'did:imajin:owner';
const root = makeAgentRun({ runId: 'root', createdAt: '2026-10-19T12:00:00Z' });
const child = makeAgentRun({ runId: 'child', parentRunId: 'root', environmentId: null,
  createdAt: '2026-10-19T12:00:00Z', requestUsage: { inferenceCost: 12, computeCost: null, platformCost: null } });
beforeEach(() => {
  vi.resetAllMocks();
  sql.mockResolvedValue([]);
  meter.mockResolvedValue(false);
  getRun.mockResolvedValue(root);
  list.mockResolvedValue({ runs: [], hasNextPage: false, nextCursor: null });
});

describe('Warp incurred lifecycle recovery', () => {
  it('replays own durable terminal records on every pass even with no in-flight roots', async () => {
    sql.mockImplementation(async (strings: TemplateStringsArray) => strings.join('').includes('ORDER BY occurred_at')
      ? [{ principalDid: OWNER, payload: child }] : []);
    meter.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await sweepWarpIncurredUsage();
    await sweepWarpIncurredUsage();
    expect(meter).toHaveBeenNthCalledWith(1, OWNER, expect.objectContaining({ runId: 'child', createdAt: child.createdAt, requestUsage: child.requestUsage }));
    expect(meter).toHaveBeenCalledTimes(2);
    expect(getRun).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('uses only locally dispatched roots and pages all descendants including terminal environment-less children', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ principalDid: OWNER, runId: 'root' }]);
    list.mockResolvedValueOnce({ runs: [child], hasNextPage: true, nextCursor: 'two' })
      .mockResolvedValueOnce({ runs: [{ ...child, runId: 'grandchild', parentRunId: 'child', state: 'FAILED' }], hasNextPage: false, nextCursor: null });
    await sweepWarpIncurredUsage();
    expect(getRun).toHaveBeenCalledWith(OWNER, 'root');
    expect(list.mock.calls).toEqual([
      [OWNER, { ancestorRunId: 'root', limit: 500 }],
      [OWNER, { ancestorRunId: 'root', limit: 500, cursor: 'two' }],
    ]);
    expect(meter.mock.calls.map(([, run]) => run.runId)).toEqual(['root', 'child', 'grandchild']);
    expect(sql.mock.calls[1][0].join('')).toContain("event_type = 'warp.agent.dispatched'");
    expect(sql.mock.calls[1][1]).toBe('2026-10-19T00:00:00.000Z');
  });

  it('does not infer a terminal meter record from incomplete legacy or malformed local payloads', async () => {
    sql.mockResolvedValueOnce([
      { principalDid: OWNER, payload: null },
      { principalDid: OWNER, payload: { runId: 'legacy' } },
      { principalDid: 123, payload: child },
    ]).mockResolvedValueOnce([]);
    await sweepWarpIncurredUsage();
    expect(meter).not.toHaveBeenCalled();
  });

  it('sanitizes provider/replay failures and continues to other local roots', async () => {
    sql.mockRejectedValueOnce(new Error('synthetic-private-marker'))
      .mockResolvedValueOnce([{ principalDid: OWNER, runId: 'root' }, { principalDid: OWNER, runId: 'other' }]);
    getRun.mockRejectedValueOnce(new Error('synthetic-private-marker')).mockResolvedValueOnce({ ...root, runId: 'other' });
    await sweepWarpIncurredUsage();
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(meter).toHaveBeenCalledWith(OWNER, expect.objectContaining({ runId: 'other' }));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('synthetic-private-marker');
  });

  it.each([null, 'repeated'])('does not silently truncate broken descendant pagination (%s)', async (nextCursor) => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ principalDid: OWNER, runId: 'root' }]);
    list.mockResolvedValue({ runs: [], hasNextPage: true, nextCursor });
    await sweepWarpIncurredUsage();
    expect(list.mock.calls.length).toBeLessThanOrEqual(2);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
