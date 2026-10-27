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
  recordWarpRunUsage: meter, WARP_INCURRED_SOURCE: 'adapter:warp', WARP_INCURRED_SINCE: '2026-10-19T00:00:00.000Z',
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

  it('keeps safe error types for replay, root lookup and provider failures', async () => {
    sql.mockRejectedValueOnce(new TypeError('synthetic-private-marker')).mockRejectedValueOnce('synthetic-private-marker');
    await sweepWarpIncurredUsage();
    expect(log.warn).toHaveBeenCalledWith({ errorType: 'TypeError', errorMessage: '[redacted]' }, 'Warp terminal usage replay unavailable; next sweep will retry');
    expect(log.warn).toHaveBeenCalledWith({ errorType: 'string', errorMessage: '[redacted]' }, 'Warp lifecycle usage roots unavailable; next sweep will retry');
    sql.mockRejectedValueOnce('synthetic-private-marker').mockResolvedValueOnce([{ principalDid: OWNER, runId: 'root' }]);
    getRun.mockRejectedValueOnce('synthetic-private-marker');
    await sweepWarpIncurredUsage();
    expect(log.warn).toHaveBeenCalledWith(
      { errorType: 'string', errorMessage: '[redacted]', principalDid: OWNER, runId: 'root' },
      'Warp lifecycle usage observation unavailable; next sweep will retry',
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('synthetic-private-marker');
  });

  it('binds the settle boundary as ISO text with an explicit timestamptz cast', async () => {
    await sweepWarpIncurredUsage(new Date('2026-10-27T12:34:56.789Z'));
    const [strings, ...values] = sql.mock.calls[1];
    expect(values).toEqual(['2026-10-19T00:00:00.000Z', 'adapter:warp', '2026-10-26T12:34:56.789Z']);
    expect(strings.join('?')).toContain('terminal.terminal_at >= ?::timestamptz');
  });

  it('retains a serializer diagnostic without logging the received value at both query catch sites', async () => {
    const message = 'The "string" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received type string (synthetic-private-marker)';
    sql.mockRejectedValueOnce(new TypeError(message)).mockRejectedValueOnce(new TypeError(message));
    await sweepWarpIncurredUsage();
    for (const [context] of log.warn.mock.calls) {
      expect(context).toEqual({
        errorType: 'TypeError',
        errorMessage: 'The "string" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received [redacted].',
      });
    }
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('synthetic-private-marker');
  });

  it('retains value-free messages for query and per-root failures', async () => {
    sql.mockRejectedValueOnce(new RangeError('Invalid time value'))
      .mockResolvedValueOnce([{ principalDid: OWNER, runId: 'root' }]);
    getRun.mockRejectedValueOnce(new Error('Warp lifecycle pagination unavailable'));
    await sweepWarpIncurredUsage();
    expect(log.warn).toHaveBeenCalledWith(
      { errorType: 'RangeError', errorMessage: 'Invalid time value' },
      'Warp terminal usage replay unavailable; next sweep will retry',
    );
    expect(log.warn).toHaveBeenCalledWith(
      { errorType: 'Error', errorMessage: 'Warp lifecycle pagination unavailable', principalDid: OWNER, runId: 'root' },
      'Warp lifecycle usage observation unavailable; next sweep will retry',
    );
  });

  it('redacts arbitrary Error messages and does not stringify thrown objects', async () => {
    const thrown = { toString: vi.fn(() => 'synthetic-private-marker') };
    sql.mockRejectedValueOnce(new Error('synthetic-private-marker')).mockRejectedValueOnce(thrown);
    await sweepWarpIncurredUsage();
    expect(log.warn.mock.calls.map(([context]) => context.errorMessage)).toEqual(['[redacted]', '[redacted]']);
    expect(thrown.toString).not.toHaveBeenCalled();
  });

  it.each([null, 'repeated'])('does not silently truncate broken descendant pagination (%s)', async (nextCursor) => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ principalDid: OWNER, runId: 'root' }]);
    list.mockResolvedValue({ runs: [], hasNextPage: true, nextCursor });
    await sweepWarpIncurredUsage();
    expect(list.mock.calls.length).toBeLessThanOrEqual(2);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
