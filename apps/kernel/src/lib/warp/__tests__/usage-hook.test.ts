import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentRun } from './run-fixture';

const { meter, publish, log } = vi.hoisted(() => ({
  meter: vi.fn(), publish: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../usage/warp-incurred', () => ({ recordWarpRunUsage: meter }));
vi.mock('@imajin/bus', () => ({ publish }));
vi.mock('@imajin/logger', () => ({ createLogger: () => log }));
vi.mock('../connector', () => ({ requireAgentKey: vi.fn() }));
vi.mock('../environment', () => ({ readEnvironmentId: vi.fn() }));
vi.mock('../loop-emit', () => ({ emitWarpRunLoopEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn() }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: vi.fn() }));
import { publishTerminalRunOutcome } from '../dispatch';

beforeEach(() => {
  vi.clearAllMocks();
  publish.mockResolvedValue(undefined);
  meter.mockResolvedValue(true);
});
describe('Warp terminal incurred hook', () => {
  it.each(['SUCCEEDED', 'CANCELLED', 'FAILED'] as const)('preserves %s lifecycle publish and records terminal metadata for recovery', async (state) => {
    const run = makeAgentRun({
      state, createdAt: '2026-10-19T12:00:00Z', modelId: 'actual-model', parentRunId: 'parent',
      requestUsage: { inferenceCost: 5, computeCost: null, platformCost: null },
    });
    await publishTerminalRunOutcome('did:owner', run, state);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(state === 'FAILED' ? 'warp.run.failed' : 'warp.run.completed', expect.objectContaining({
      payload: expect.objectContaining({ createdAt: run.createdAt, modelId: run.modelId, parentRunId: run.parentRunId, requestUsage: run.requestUsage }),
    }));
    expect(meter).toHaveBeenCalledWith('did:owner', run);
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(meter.mock.invocationCallOrder[0]);
  });
  it('never turns meter exceptions into failed completion or logs underlying errors', async () => {
    meter.mockRejectedValueOnce(new Error('synthetic-private-marker'));
    await expect(publishTerminalRunOutcome('did:owner', makeAgentRun(), 'SUCCEEDED')).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('synthetic-private-marker');
  });
});
