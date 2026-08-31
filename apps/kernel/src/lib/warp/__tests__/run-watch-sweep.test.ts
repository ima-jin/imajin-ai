/**
 * Tests for the Warp run watch scheduled fallback sweep (#1838).
 *
 * `@imajin/db` is mocked with a tagged-template function that inspects the
 * query text (the same pattern used in
 * apps/kernel/src/lib/media/__tests__/projection-reactor.test.ts): the two
 * queries this module issues are told apart by the literal event-type strings
 * baked into the SQL text, not by call order.
 *
 * `../dispatch` is mocked wholesale so this suite never makes a real Warp API
 * call or a real bus publish — it only pins the sweep's own orchestration:
 * which candidates it reads, which publish function it calls for each state,
 * and how it counts the outcome.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getAgentRunMock,
  publishTerminalRunOutcomeMock,
  publishBlockedRunOutcomeMock,
  candidateRows,
  blockedNoticeRows,
  listingFailure,
  FakeWarpApiErrorHoisted,
} = vi.hoisted(() => ({
  getAgentRunMock: vi.fn(),
  publishTerminalRunOutcomeMock: vi.fn().mockResolvedValue(undefined),
  publishBlockedRunOutcomeMock: vi.fn().mockResolvedValue(undefined),
  candidateRows: [] as Array<{ runId: unknown; principalDid: unknown; dispatchedAt: unknown }>,
  blockedNoticeRows: new Set<string>(),
  listingFailure: { error: null as Error | null },
  FakeWarpApiErrorHoisted: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@imajin/db', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('warp.agent.dispatched')) {
      if (listingFailure.error) return Promise.reject(listingFailure.error);
      return Promise.resolve(candidateRows);
    }
    if (text.includes('warp.run.blocked')) {
      const runId = values[0] as string;
      return Promise.resolve(blockedNoticeRows.has(runId) ? [{ x: 1 }] : []);
    }
    return Promise.resolve([]);
  };
  return { getClient: () => sql };
});

vi.mock('../dispatch', () => ({
  getAgentRun: getAgentRunMock,
  isTerminalRunState: (state: string | null) =>
    state !== null && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state),
  publishTerminalRunOutcome: publishTerminalRunOutcomeMock,
  publishBlockedRunOutcome: publishBlockedRunOutcomeMock,
  WarpApiError: FakeWarpApiErrorHoisted,
}));

import { sweepInFlightWarpRuns } from '../run-watch-sweep';

const PRINCIPAL = 'did:imajin:veteze';

function run(state: string | null, runId = 'run-1'): { runId: string; state: string | null } {
  return { runId, state };
}

function seedCandidate(runId: string, principalDid = PRINCIPAL, dispatchedAt = new Date()): void {
  candidateRows.push({ runId, principalDid, dispatchedAt });
}

beforeEach(() => {
  vi.clearAllMocks();
  candidateRows.length = 0;
  blockedNoticeRows.clear();
  listingFailure.error = null;
  getAgentRunMock.mockReset();
  publishTerminalRunOutcomeMock.mockReset().mockResolvedValue(undefined);
  publishBlockedRunOutcomeMock.mockReset().mockResolvedValue(undefined);
});

describe('sweepInFlightWarpRuns', () => {
  it('is a no-op when there are no in-flight dispatched runs', async () => {
    const outcome = await sweepInFlightWarpRuns();

    expect(outcome).toEqual({ checked: 0, completed: 0, failed: 0, blockedNotified: 0, stillInFlight: 0, errors: 0 });
    expect(getAgentRunMock).not.toHaveBeenCalled();
  });

  it('publishes the terminal outcome and counts SUCCEEDED as completed', async () => {
    seedCandidate('run-1');
    getAgentRunMock.mockResolvedValue(run('SUCCEEDED', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(getAgentRunMock).toHaveBeenCalledWith(PRINCIPAL, 'run-1');
    expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(PRINCIPAL, run('SUCCEEDED', 'run-1'), 'SUCCEEDED');
    expect(outcome).toMatchObject({ checked: 1, completed: 1, failed: 0, stillInFlight: 0 });
  });

  it('counts CANCELLED as completed too, same as the in-request watch', async () => {
    seedCandidate('run-1');
    getAgentRunMock.mockResolvedValue(run('CANCELLED', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(PRINCIPAL, run('CANCELLED', 'run-1'), 'CANCELLED');
    expect(outcome.completed).toBe(1);
    expect(outcome.failed).toBe(0);
  });

  it('counts FAILED separately from completed', async () => {
    seedCandidate('run-1');
    getAgentRunMock.mockResolvedValue(run('FAILED', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(PRINCIPAL, run('FAILED', 'run-1'), 'FAILED');
    expect(outcome.failed).toBe(1);
    expect(outcome.completed).toBe(0);
  });

  it('publishes warp.run.blocked for a run newly observed as BLOCKED', async () => {
    seedCandidate('run-1');
    getAgentRunMock.mockResolvedValue(run('BLOCKED', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(publishBlockedRunOutcomeMock).toHaveBeenCalledWith(PRINCIPAL, run('BLOCKED', 'run-1'));
    expect(publishTerminalRunOutcomeMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ checked: 1, blockedNotified: 1, stillInFlight: 0 });
  });

  it('does not re-publish warp.run.blocked when a prior tick already notified', async () => {
    seedCandidate('run-1');
    blockedNoticeRows.add('run-1');
    getAgentRunMock.mockResolvedValue(run('BLOCKED', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(publishBlockedRunOutcomeMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ checked: 1, blockedNotified: 0, stillInFlight: 1 });
  });

  it('counts a run that is neither terminal nor blocked as still in flight, publishing nothing', async () => {
    seedCandidate('run-1');
    getAgentRunMock.mockResolvedValue(run('INPROGRESS', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(publishTerminalRunOutcomeMock).not.toHaveBeenCalled();
    expect(publishBlockedRunOutcomeMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ checked: 1, stillInFlight: 1 });
  });

  it('checks every candidate independently and totals the outcome across them', async () => {
    seedCandidate('run-1', 'did:imajin:a');
    seedCandidate('run-2', 'did:imajin:b');
    seedCandidate('run-3', 'did:imajin:c');
    getAgentRunMock.mockImplementation((principalDid: string, runId: string) => {
      if (runId === 'run-1') return Promise.resolve(run('SUCCEEDED', runId));
      if (runId === 'run-2') return Promise.resolve(run('BLOCKED', runId));
      return Promise.resolve(run('INPROGRESS', runId));
    });

    const outcome = await sweepInFlightWarpRuns();

    expect(outcome).toMatchObject({ checked: 3, completed: 1, blockedNotified: 1, stillInFlight: 1 });
  });

  it('counts a failed read as an error and keeps checking the remaining candidates', async () => {
    seedCandidate('run-1');
    seedCandidate('run-2');
    getAgentRunMock.mockImplementation((principalDid: string, runId: string) => {
      if (runId === 'run-1') return Promise.reject(new FakeWarpApiErrorHoisted('not found', 404));
      return Promise.resolve(run('SUCCEEDED', runId));
    });

    const outcome = await sweepInFlightWarpRuns();

    expect(outcome).toMatchObject({ checked: 2, errors: 1, completed: 1 });
  });

  it('never throws when listing candidates itself fails', async () => {
    listingFailure.error = new Error('connection refused');

    await expect(sweepInFlightWarpRuns()).resolves.toEqual({
      checked: 0,
      completed: 0,
      failed: 0,
      blockedNotified: 0,
      stillInFlight: 0,
      errors: 0,
    });
    expect(getAgentRunMock).not.toHaveBeenCalled();
  });
});
