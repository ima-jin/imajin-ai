/**
 * Tests for the Warp run watch scheduled fallback sweep (#1838; segment-aware
 * in-flight tracking and genuine-timeout detection added by #2032).
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
  publishTimeoutRunOutcomeMock,
  candidateRows,
  blockedNoticeRows,
  listingFailure,
  FakeWarpApiErrorHoisted,
} = vi.hoisted(() => ({
  getAgentRunMock: vi.fn(),
  publishTerminalRunOutcomeMock: vi.fn().mockResolvedValue(undefined),
  publishBlockedRunOutcomeMock: vi.fn().mockResolvedValue(undefined),
  publishTimeoutRunOutcomeMock: vi.fn().mockResolvedValue(undefined),
  candidateRows: [] as Array<{
    runId: unknown;
    principalDid: unknown;
    activityAt: unknown;
    resumeCount: unknown;
    previousSessionId: unknown;
  }>,
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
  publishTimeoutRunOutcome: publishTimeoutRunOutcomeMock,
  WarpApiError: FakeWarpApiErrorHoisted,
}));

import { sweepInFlightWarpRuns, SWEEP_LOOKBACK_MS } from '../run-watch-sweep';

const PRINCIPAL = 'did:imajin:veteze';

function run(state: string | null, runId = 'run-1'): { runId: string; state: string | null } {
  return { runId, state };
}

function seedCandidate(
  runId: string,
  overrides: {
    principalDid?: string;
    activityAt?: Date;
    resumeCount?: number;
    previousSessionId?: string | null;
  } = {},
): void {
  candidateRows.push({
    runId,
    principalDid: overrides.principalDid ?? PRINCIPAL,
    activityAt: overrides.activityAt ?? new Date(),
    resumeCount: overrides.resumeCount ?? 0,
    previousSessionId: overrides.previousSessionId ?? null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  candidateRows.length = 0;
  blockedNoticeRows.clear();
  listingFailure.error = null;
  getAgentRunMock.mockReset();
  publishTerminalRunOutcomeMock.mockReset().mockResolvedValue(undefined);
  publishBlockedRunOutcomeMock.mockReset().mockResolvedValue(undefined);
  publishTimeoutRunOutcomeMock.mockReset().mockResolvedValue(undefined);
});

describe('sweepInFlightWarpRuns', () => {
  it('is a no-op when there are no in-flight runs', async () => {
    const outcome = await sweepInFlightWarpRuns();

    expect(outcome).toEqual({
      checked: 0,
      completed: 0,
      failed: 0,
      blockedNotified: 0,
      stillInFlight: 0,
      timedOut: 0,
      errors: 0,
    });
    expect(getAgentRunMock).not.toHaveBeenCalled();
  });

  it('publishes the terminal outcome and counts SUCCEEDED as completed, with no resume context', async () => {
    seedCandidate('run-1');
    getAgentRunMock.mockResolvedValue(run('SUCCEEDED', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(getAgentRunMock).toHaveBeenCalledWith(PRINCIPAL, 'run-1');
    expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(
      PRINCIPAL,
      run('SUCCEEDED', 'run-1'),
      'SUCCEEDED',
      undefined,
    );
    expect(outcome).toMatchObject({ checked: 1, completed: 1, failed: 0, stillInFlight: 0 });
  });

  it('counts CANCELLED as completed too, same as the in-request watch', async () => {
    seedCandidate('run-1');
    getAgentRunMock.mockResolvedValue(run('CANCELLED', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(
      PRINCIPAL,
      run('CANCELLED', 'run-1'),
      'CANCELLED',
      undefined,
    );
    expect(outcome.completed).toBe(1);
    expect(outcome.failed).toBe(0);
  });

  it('counts FAILED separately from completed', async () => {
    seedCandidate('run-1');
    getAgentRunMock.mockResolvedValue(run('FAILED', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(
      PRINCIPAL,
      run('FAILED', 'run-1'),
      'FAILED',
      undefined,
    );
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

  it('counts a run that is neither terminal nor blocked as still in flight, publishing nothing, when within the lookback', async () => {
    seedCandidate('run-1', { activityAt: new Date() });
    getAgentRunMock.mockResolvedValue(run('INPROGRESS', 'run-1'));

    const outcome = await sweepInFlightWarpRuns();

    expect(publishTerminalRunOutcomeMock).not.toHaveBeenCalled();
    expect(publishBlockedRunOutcomeMock).not.toHaveBeenCalled();
    expect(publishTimeoutRunOutcomeMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ checked: 1, stillInFlight: 1, timedOut: 0 });
  });

  it('checks every candidate independently and totals the outcome across them', async () => {
    seedCandidate('run-1', { principalDid: 'did:imajin:a' });
    seedCandidate('run-2', { principalDid: 'did:imajin:b' });
    seedCandidate('run-3', { principalDid: 'did:imajin:c' });
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
      timedOut: 0,
      errors: 0,
    });
    expect(getAgentRunMock).not.toHaveBeenCalled();
  });

  // ── Genuine timeout (#2032) ─────────────────────────────────────────────

  describe('genuine timeout', () => {
    it('publishes warp.run.timeout when activity is past the lookback and the run is still non-terminal', async () => {
      const staleActivity = new Date(Date.now() - (SWEEP_LOOKBACK_MS + 60_000));
      seedCandidate('run-1', { activityAt: staleActivity });
      getAgentRunMock.mockResolvedValue(run('INPROGRESS', 'run-1'));

      const outcome = await sweepInFlightWarpRuns();

      expect(publishTimeoutRunOutcomeMock).toHaveBeenCalledWith(PRINCIPAL, 'run-1', 'INPROGRESS');
      expect(publishTerminalRunOutcomeMock).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ checked: 1, timedOut: 1, stillInFlight: 0 });
    });

    it('reports terminal instead of timeout when a stale run turns out to have actually finished', async () => {
      const staleActivity = new Date(Date.now() - (SWEEP_LOOKBACK_MS + 60_000));
      seedCandidate('run-1', { activityAt: staleActivity });
      getAgentRunMock.mockResolvedValue(run('SUCCEEDED', 'run-1'));

      const outcome = await sweepInFlightWarpRuns();

      expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(
        PRINCIPAL,
        run('SUCCEEDED', 'run-1'),
        'SUCCEEDED',
        undefined,
      );
      expect(publishTimeoutRunOutcomeMock).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ checked: 1, completed: 1, timedOut: 0 });
    });

    it('does not time out a stale BLOCKED run — it still just gets the blocked nudge', async () => {
      const staleActivity = new Date(Date.now() - (SWEEP_LOOKBACK_MS + 60_000));
      seedCandidate('run-1', { activityAt: staleActivity });
      getAgentRunMock.mockResolvedValue(run('BLOCKED', 'run-1'));

      const outcome = await sweepInFlightWarpRuns();

      expect(publishBlockedRunOutcomeMock).toHaveBeenCalledWith(PRINCIPAL, run('BLOCKED', 'run-1'));
      expect(publishTimeoutRunOutcomeMock).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ checked: 1, blockedNotified: 1, timedOut: 0 });
    });

    it('honours an overridden lookbackMs', async () => {
      seedCandidate('run-1', { activityAt: new Date(Date.now() - 1_000) });
      getAgentRunMock.mockResolvedValue(run('INPROGRESS', 'run-1'));

      const outcome = await sweepInFlightWarpRuns({ lookbackMs: 500 });

      expect(publishTimeoutRunOutcomeMock).toHaveBeenCalledWith(PRINCIPAL, 'run-1', 'INPROGRESS');
      expect(outcome.timedOut).toBe(1);
    });
  });

  // ── Segment-aware resume context (#2032) ───────────────────────────────

  describe('resumed segments', () => {
    it('passes no resume context for a run that has never been resumed', async () => {
      seedCandidate('run-1', { resumeCount: 0 });
      getAgentRunMock.mockResolvedValue(run('SUCCEEDED', 'run-1'));

      await sweepInFlightWarpRuns();

      expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(
        PRINCIPAL,
        run('SUCCEEDED', 'run-1'),
        'SUCCEEDED',
        undefined,
      );
    });

    it('passes resumedFrom and segment 2 for a run resumed once before completing', async () => {
      seedCandidate('run-1', { resumeCount: 1, previousSessionId: 'session-a' });
      getAgentRunMock.mockResolvedValue(run('SUCCEEDED', 'run-1'));

      await sweepInFlightWarpRuns();

      expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(
        PRINCIPAL,
        run('SUCCEEDED', 'run-1'),
        'SUCCEEDED',
        { resumedFrom: 'session-a', segment: 2 },
      );
    });

    it('increments segment for each additional resume', async () => {
      seedCandidate('run-1', { resumeCount: 2, previousSessionId: 'session-b' });
      getAgentRunMock.mockResolvedValue(run('FAILED', 'run-1'));

      await sweepInFlightWarpRuns();

      expect(publishTerminalRunOutcomeMock).toHaveBeenCalledWith(
        PRINCIPAL,
        run('FAILED', 'run-1'),
        'FAILED',
        { resumedFrom: 'session-b', segment: 3 },
      );
    });

    it('is visible to the sweep again even though its first segment already completed (the #2032 bug)', async () => {
      // This candidate simulates what the segment-aware SQL query returns: a
      // run whose first segment's warp.run.completed row exists, but whose
      // latest warp.run.resumed row is newer than it — so the query still
      // surfaces it as in-flight. Pre-#2032 the plain existence-based
      // anti-join would have excluded it forever once any terminal row
      // existed for the runId.
      seedCandidate('run-1', { resumeCount: 1, previousSessionId: 'session-a' });
      getAgentRunMock.mockResolvedValue(run('SUCCEEDED', 'run-1'));

      const outcome = await sweepInFlightWarpRuns();

      expect(publishTerminalRunOutcomeMock).toHaveBeenCalledTimes(1);
      expect(outcome.completed).toBe(1);
    });
  });
});
