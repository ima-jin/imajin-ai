/**
 * Tests for the Warp run completion watch (#1639, Stage 3).
 *
 * The watch is driven through the real `getAgentRun` read path with `fetch`
 * mocked, so these pin the poll schedule, the terminal-state detection, and the
 * shape of the bus event a listener will actually receive.
 *
 * Two things are injected rather than faked globally:
 *   - `sleep`, which records the gap it was asked for and advances a stubbed
 *     `Date.now` by exactly that much. The schedule and the 30-minute budget are
 *     therefore asserted on in wall-clock terms while the suite runs instantly.
 *   - nothing else. `WATCH_POLL_INTERVALS_MS` and `WATCH_TIMEOUT_MS` are the real
 *     production values here, so a change to either breaks these tests rather
 *     than sliding past them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  requireAgentKeyMock,
  lookupIdentityMock,
  publishMock,
  logMock,
  readEnvironmentIdMock,
  getNodeDidMock,
} = vi.hoisted(() => ({
  requireAgentKeyMock: vi.fn(),
  lookupIdentityMock: vi.fn(),
  publishMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  readEnvironmentIdMock: vi.fn(),
  getNodeDidMock: vi.fn(),
}));

vi.mock('../connector', () => ({
  requireAgentKey: requireAgentKeyMock,
}));

vi.mock('../environment', () => ({
  readEnvironmentId: readEnvironmentIdMock,
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: getNodeDidMock,
}));

vi.mock('@/src/lib/kernel/lookup', () => ({
  lookupIdentity: lookupIdentityMock,
}));

vi.mock('@imajin/bus', () => ({
  publish: publishMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

import { watchRun, WATCH_POLL_INTERVALS_MS, WATCH_TIMEOUT_MS } from '../dispatch';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PRINCIPAL = 'did:imajin:veteze';
const AGENT_KEY = 'warp-agent-key-SUPER-SECRET-VALUE';
const BASE_URL = 'https://warp.test/api/v1';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';

/** Gaps the watch asked to sleep for, in order. */
let slept: number[] = [];
/** Stubbed clock, advanced only by the injected sleep. */
let clockMs = 0;

/** The injected delay: instant, but it moves the clock the watch budgets against. */
function sleep(ms: number): Promise<void> {
  slept.push(ms);
  clockMs += ms;
  return Promise.resolve();
}

/** Queue one `GET /agent/runs/{id}` answer. */
function respondRun(body: unknown, status = 200): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Test',
    json: async () => body,
  } as Response);
}

/** Answer every remaining read the same way. */
function respondRunAlways(body: unknown, status = 200): void {
  vi.mocked(globalThis.fetch).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Test',
    json: async () => body,
  } as Response);
}

function runBody(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { run_id: RUN_ID, state, ...extra };
}

interface PublishedEvent {
  type: string;
  issuer: string;
  subject: string;
  scope: string;
  payload: Record<string, unknown>;
}

/** The single event the watch published, or a failure if it published none. */
function publishedEvent(index = 0): PublishedEvent {
  const call = publishMock.mock.calls[index] as
    | [string, { issuer: string; subject: string; scope: string; payload: Record<string, unknown> }]
    | undefined;
  if (call === undefined) {
    throw new Error(`no event published at index ${index}`);
  }
  return { type: call[0], ...call[1] };
}

function readCount(): number {
  return vi.mocked(globalThis.fetch).mock.calls.length;
}

beforeEach(() => {
  process.env.WARP_API_BASE_URL = BASE_URL;

  slept = [];
  clockMs = 1_760_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clockMs);

  requireAgentKeyMock.mockReset().mockResolvedValue(AGENT_KEY);
  lookupIdentityMock.mockReset().mockResolvedValue({ did: PRINCIPAL, handle: 'veteze' });
  publishMock.mockReset().mockResolvedValue(undefined);
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();

  readEnvironmentIdMock.mockReset();
  getNodeDidMock.mockReset();

  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.WARP_API_BASE_URL;
});

// ── The poll schedule ─────────────────────────────────────────────────────────

describe('poll schedule', () => {
  it('backs off 5s, 10s, 30s, then holds at 60s', async () => {
    respondRun(runBody('QUEUED'));
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(slept).toEqual([5_000, 10_000, 30_000, 60_000, 60_000]);
    expect(WATCH_POLL_INTERVALS_MS).toEqual([5_000, 10_000, 30_000, 60_000]);
  });

  it('waits before the first read, so a just-queued run is not hammered', async () => {
    respondRunAlways(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(slept).toEqual([5_000]);
    expect(readCount()).toBe(1);
  });

  it('reads with the caller own sealed key, run id url-encoded', async () => {
    respondRunAlways(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, '../../agent/runs', { sleep });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/agent/runs/..%2F..%2Fagent%2Fruns`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${AGENT_KEY}`);
  });
});

// ── Terminal states ───────────────────────────────────────────────────────────

describe('terminal states', () => {
  it('publishes warp.run.completed with the metadata a listener acts on', async () => {
    respondRun(runBody('INPROGRESS'));
    respondRun(
      runBody('SUCCEEDED', {
        title: 'Nightly',
        session_link: 'https://app.warp.dev/session/abc',
        run_time: 'PT2M30S',
        agent_config: { name: 'veteze-jin' },
        request_usage: { inference_cost: 0.42, compute_cost: 0.1, platform_cost: 0 },
        artifacts: [
          {
            artifact_type: 'PULL_REQUEST',
            data: { url: 'https://github.com/ima-jin/imajin-ai/pull/1638', branch: 'fix/1630' },
          },
          { artifact_type: 'PLAN', data: { plan_id: 'plan-1' } },
        ],
      }),
    );

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const event = publishedEvent();
    expect(event.type).toBe('warp.run.completed');
    expect(event.issuer).toBe(PRINCIPAL);
    expect(event.subject).toBe(PRINCIPAL);
    expect(event.scope).toBe('warp');
    expect(event.payload).toMatchObject({
      runId: RUN_ID,
      state: 'SUCCEEDED',
      title: 'Nightly',
      configName: 'veteze-jin',
      runTime: 'PT2M30S',
      sessionLink: 'https://app.warp.dev/session/abc',
      principalDid: PRINCIPAL,
      requestUsage: { inferenceCost: 0.42, computeCost: 0.1, platformCost: 0 },
      // Same context as warp.agent.dispatched — dispatch and completion are one thread.
      context_id: RUN_ID,
      context_type: 'warp.agent',
    });
    expect(typeof event.payload.completedAt).toBe('string');
  });

  it('flattens artifacts to the PR linkage, dropping the rest of Warp own data', async () => {
    respondRun(
      runBody('SUCCEEDED', {
        artifacts: [
          {
            artifact_type: 'PULL_REQUEST',
            data: { url: 'https://github.com/ima-jin/imajin-ai/pull/1638', branch: 'fix/1630' },
          },
          { artifact_type: 'PLAN', data: { plan_id: 'plan-1' } },
          { data: { url: 'https://example.test/thing' } },
        ],
      }),
    );

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(publishedEvent().payload.artifacts).toEqual([
      { type: 'PULL_REQUEST', url: 'https://github.com/ima-jin/imajin-ai/pull/1638', branch: 'fix/1630' },
      { type: 'PLAN', url: null, branch: null },
      { type: 'UNKNOWN', url: 'https://example.test/thing', branch: null },
    ]);
  });

  it('carries the failure reason so a failed run is diagnosable from the event', async () => {
    respondRun(
      runBody('FAILED', {
        status_message: {
          message: 'Team has no remaining add-on credits',
          error_code: 'insufficient_credits',
          retryable: false,
        },
      }),
    );

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(publishedEvent().payload).toMatchObject({
      state: 'FAILED',
      statusMessage: {
        message: 'Team has no remaining add-on credits',
        errorCode: 'insufficient_credits',
        retryable: false,
      },
    });
  });

  it('treats CANCELLED as an ending rather than watching it for another 30 minutes', async () => {
    respondRun(runBody('CANCELLED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(publishedEvent().payload).toMatchObject({ state: 'CANCELLED' });
    expect(readCount()).toBe(1);
  });

  it('keeps watching a BLOCKED run, which is waiting on a human rather than finished', async () => {
    respondRun(runBody('BLOCKED'));
    respondRun(runBody('BLOCKED'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(readCount()).toBe(3);
    expect(publishedEvent().payload).toMatchObject({ state: 'SUCCEEDED' });
  });

  it('publishes exactly one event and stops reading once terminal', async () => {
    respondRunAlways(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(readCount()).toBe(1);
  });
});

// ── Timeout ───────────────────────────────────────────────────────────────────

describe('timeout', () => {
  it('gives up after 30 minutes and says so instead of going quiet', async () => {
    respondRunAlways(runBody('INPROGRESS'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const event = publishedEvent();
    expect(event.type).toBe('warp.run.timeout');
    expect(event.payload).toMatchObject({
      runId: RUN_ID,
      lastKnownState: 'INPROGRESS',
      principalDid: PRINCIPAL,
      context_id: RUN_ID,
      context_type: 'warp.agent',
    });
    expect(typeof event.payload.timedOutAt).toBe('string');
  });

  it('spends exactly the budget, never overshooting the final interval', async () => {
    respondRunAlways(runBody('INPROGRESS'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(WATCH_TIMEOUT_MS).toBe(30 * 60 * 1_000);
    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(WATCH_TIMEOUT_MS);
    expect(Math.max(...slept)).toBeLessThanOrEqual(60_000);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('reports UNKNOWN when the budget is gone before the first read', async () => {
    respondRunAlways(runBody('INPROGRESS'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep, timeoutMs: 0 });

    const event = publishedEvent();
    expect(event.type).toBe('warp.run.timeout');
    expect(event.payload).toMatchObject({ lastKnownState: 'UNKNOWN' });
    expect(readCount()).toBe(0);
  });
});

// ── Read failures ─────────────────────────────────────────────────────────────

describe('read failures', () => {
  it('retries a transient upstream failure and still reports the completion', async () => {
    respondRun({ title: 'Bad Gateway' }, 502);
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(publishedEvent().type).toBe('warp.run.completed');
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('abandons the watch after five consecutive failures, publishing nothing', async () => {
    respondRunAlways({ title: 'Bad Gateway' }, 502);

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(readCount()).toBe(5);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('stops on the first 404, because retrying cannot make the run visible', async () => {
    respondRunAlways({ title: 'Not Found' }, 404);

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(readCount()).toBe(1);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('stops immediately when the grant is revoked mid-watch', async () => {
    requireAgentKeyMock.mockRejectedValue(new Error('warp_no_grant: revoked'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(readCount()).toBe(0);
    expect(publishMock).not.toHaveBeenCalled();
  });
});

// ── Fire-and-forget safety ────────────────────────────────────────────────────

describe('the watch never throws', () => {
  it('swallows a rejecting bus publish', async () => {
    publishMock.mockRejectedValue(new Error('bus down'));
    respondRun(runBody('SUCCEEDED'));

    await expect(watchRun(PRINCIPAL, RUN_ID, { sleep })).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('swallows an invalid run id rather than rejecting into the void', async () => {
    await expect(watchRun(PRINCIPAL, '   ', { sleep })).resolves.toBeUndefined();

    expect(readCount()).toBe(0);
    expect(publishMock).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('swallows a network-level fetch rejection', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('fetch failed'));

    await expect(watchRun(PRINCIPAL, RUN_ID, { sleep })).resolves.toBeUndefined();
    expect(publishMock).not.toHaveBeenCalled();
  });
});

// ── Secret hygiene ────────────────────────────────────────────────────────────

describe('the sealed key never reaches the bus', () => {
  it('is absent from the completion event and the log lines', async () => {
    respondRun(runBody('SUCCEEDED', { session_link: 'https://app.warp.dev/session/abc' }));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(JSON.stringify(publishMock.mock.calls)).not.toContain(AGENT_KEY);
    expect(JSON.stringify(logMock.info.mock.calls)).not.toContain(AGENT_KEY);
  });
});
