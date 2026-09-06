/**
 * Acceptance test for #2043: a concurrent-invocation race between the
 * in-request watch (`watchRun`, `dispatch.ts`) and the scheduled sweep
 * (`checkOneRun`, `run-watch-sweep.ts`) on the same run must produce exactly
 * one terminal event, regardless of which side observes the terminal state
 * first.
 *
 * Unlike `watch-run.test.ts` and `run-watch-sweep.test.ts` (which mock
 * `../dispatch`/`../run-watch-sweep` wholesale to pin each module's own
 * orchestration in isolation), this suite exercises the REAL `watchRun` and
 * the REAL `claimTerminalPublish` together, sharing one in-memory
 * `@imajin/db` double that faithfully models the migration 0127 table's
 * `INSERT ... ON CONFLICT (run_id, segment) DO NOTHING RETURNING` semantics:
 * only the first insert for a given `(run_id, segment)` key ever returns a
 * row. That is the one property the whole fix depends on, and it is real
 * application code — not a test double — deciding whether to publish based
 * on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireAgentKeyMock, publishMock, logMock } = vi.hoisted(() => ({
  requireAgentKeyMock: vi.fn(),
  publishMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../connector', () => ({
  requireAgentKey: requireAgentKeyMock,
}));

// `dispatch.ts` also imports these at module load time (even though
// `watchRun` never calls them); mocked the same way `watch-run.test.ts` does,
// so this suite never pulls in `@/src/lib/kernel/db` transitively.
vi.mock('../environment', () => ({
  readEnvironmentId: vi.fn(),
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: vi.fn(),
}));

vi.mock('@/src/lib/kernel/lookup', () => ({
  lookupIdentity: vi.fn(),
}));

vi.mock('@imajin/bus', () => ({
  publish: publishMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

/**
 * A faithful double of the migration 0127 claim table: a plain `Map` keyed by
 * `${runId}:${segment}`, with "insert if absent, return whether it was
 * absent" as its only operation — exactly what
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING` guarantees atomically in
 * real Postgres. `claimTerminalPublish` (`run-watch-sweep.ts`) is the only
 * thing under test that touches this.
 */
const claims = new Map<string, string>();

vi.mock('@imajin/db', () => ({
  getClient: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (!text.includes('warp_terminal_publish_claims')) {
      return Promise.resolve([]);
    }
    const [runId, segment, claimedBy] = values as [string, number, string];
    const key = `${runId}:${segment}`;
    if (claims.has(key)) return Promise.resolve([]);
    claims.set(key, claimedBy);
    return Promise.resolve([{ run_id: runId }]);
  },
}));

import { watchRun } from '../dispatch';
import { claimTerminalPublish } from '../run-watch-sweep';

const PRINCIPAL = 'did:imajin:veteze';
const AGENT_KEY = 'warp-agent-key-SUPER-SECRET-VALUE';
const BASE_URL = 'https://warp.test/api/v1';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';

/** Instant, synchronous sleep so the watch's poll loop runs without delay. */
function sleep(_ms: number): Promise<void> {
  return Promise.resolve();
}

function runResponse(state: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ run_id: RUN_ID, state }),
  } as Response;
}

beforeEach(() => {
  process.env.WARP_API_BASE_URL = BASE_URL;
  claims.clear();
  requireAgentKeyMock.mockReset().mockResolvedValue(AGENT_KEY);
  publishMock.mockReset().mockResolvedValue(undefined);
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
  // The run is terminal on the very first read for every test in this file.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => runResponse('SUCCEEDED')),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WARP_API_BASE_URL;
});

function terminalPublishCount(): number {
  return publishMock.mock.calls.filter(([type]: [string]) =>
    ['warp.run.completed', 'warp.run.failed', 'warp.run.timeout'].includes(type),
  ).length;
}

describe('terminal publish claim: concurrent watch/sweep race (#2043 acceptance)', () => {
  it('publishes exactly one terminal event when the sweep wins the claim before the watch tries', async () => {
    // The sweep observed terminal first and already won the claim for this
    // run's (only) segment — simulated directly via the shared primitive,
    // since `checkOneRun` itself is not exported.
    const sweepClaimed = await claimTerminalPublish(RUN_ID, 1, 'sweep');
    expect(sweepClaimed).toBe(true);

    await watchRun(PRINCIPAL, RUN_ID, { sleep, claimTerminalPublish });

    // The watch's own claim attempt for the same segment must lose, so it
    // must not publish a second time.
    expect(terminalPublishCount()).toBe(0);
  });

  it('publishes exactly one terminal event when the watch wins the claim before the sweep tries', async () => {
    await watchRun(PRINCIPAL, RUN_ID, { sleep, claimTerminalPublish });

    expect(terminalPublishCount()).toBe(1);

    // The sweep's own independent claim attempt for the same segment,
    // moments later, must now lose.
    const sweepClaimed = await claimTerminalPublish(RUN_ID, 1, 'sweep');
    expect(sweepClaimed).toBe(false);
    expect(terminalPublishCount()).toBe(1);
  });

  it('under true concurrency, exactly one of two simultaneous claims for the same segment wins', async () => {
    const [watchClaimed, sweepClaimed] = await Promise.all([
      claimTerminalPublish(RUN_ID, 1, 'in-request-watch'),
      claimTerminalPublish(RUN_ID, 1, 'sweep'),
    ]);

    expect([watchClaimed, sweepClaimed].filter(Boolean)).toHaveLength(1);
  });

  it('never blocks a different run or a different segment of the same run', async () => {
    await watchRun(PRINCIPAL, RUN_ID, { sleep, claimTerminalPublish });
    expect(terminalPublishCount()).toBe(1);

    // A different run's segment 1 is unaffected.
    await expect(claimTerminalPublish('another-run', 1, 'sweep')).resolves.toBe(true);
    // A resumed segment 2 of the SAME run is also unaffected — it is a
    // different (runId, segment) key entirely.
    await expect(claimTerminalPublish(RUN_ID, 2, 'sweep')).resolves.toBe(true);
  });
});
