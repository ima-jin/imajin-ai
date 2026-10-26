/**
 * Tests for the warp.run.* -> loop.* bridge wired into `dispatch.ts` (#2296).
 *
 * `../loop-emit` is mocked wholesale so these pin exactly what `dispatch.ts`
 * hands the bridge for each transition (dispatched, resumed, progress,
 * blocked, completed, failed, timeout), the idempotency guarantee inherited
 * from the existing watch/sweep guards, and the resume case — without ever
 * touching a real database. `fetch`, the connector gate, identity lookup,
 * and the bus are mocked the same way `dispatch.test.ts`/`watch-run.test.ts`
 * already do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  requireAgentKeyMock,
  lookupIdentityMock,
  publishMock,
  logMock,
  readEnvironmentIdMock,
  getNodeDidMock,
  emitWarpRunLoopEventMock,
} = vi.hoisted(() => ({
  requireAgentKeyMock: vi.fn(),
  lookupIdentityMock: vi.fn(),
  publishMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  readEnvironmentIdMock: vi.fn(),
  getNodeDidMock: vi.fn(),
  emitWarpRunLoopEventMock: vi.fn(),
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

vi.mock('../loop-emit', () => ({
  emitWarpRunLoopEvent: emitWarpRunLoopEventMock,
}));
vi.mock('../brief-ledger', () => ({ recordWarpBrief: vi.fn().mockResolvedValue({
  hash: 'a'.repeat(64), assetId: 'asset_brief', storage: 'full-text', browserTesting: null,
}) }));

import {
  dispatchAgentRun,
  sendFollowup,
  watchRun,
  publishTimeoutRunOutcome,
} from '../dispatch';
import { recordWarpBrief } from '../brief-ledger';
import { createHash } from 'node:crypto';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PRINCIPAL = 'did:imajin:veteze';
const AGENT_KEY = 'warp-agent-key-SUPER-SECRET-VALUE';
const BASE_URL = 'https://warp.test/api/v1';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';

interface LoopEventCall {
  type: string;
  runId: string;
  principalDid: string;
  parentRunId: string | null;
  state: string;
  summary: string;
  at: string;
}

function loopEventsOfType(type: string): LoopEventCall[] {
  return emitWarpRunLoopEventMock.mock.calls
    .map(([transition]: [LoopEventCall]) => transition)
    .filter((transition: LoopEventCall) => transition.type === type);
}

beforeEach(() => {
  vi.mocked(recordWarpBrief).mockResolvedValue({
    hash: 'a'.repeat(64), assetId: 'asset_brief', storage: 'full-text', browserTesting: null,
  });
  process.env.WARP_API_BASE_URL = BASE_URL;

  requireAgentKeyMock.mockReset().mockResolvedValue(AGENT_KEY);
  lookupIdentityMock.mockReset().mockResolvedValue({ did: PRINCIPAL, handle: 'veteze' });
  publishMock.mockReset().mockResolvedValue(undefined);
  emitWarpRunLoopEventMock.mockReset().mockResolvedValue(true);
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();

  readEnvironmentIdMock.mockReset();
  readEnvironmentIdMock.mockResolvedValue(undefined);
  getNodeDidMock.mockReset().mockResolvedValue('did:imajin:node');

  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.WARP_API_BASE_URL;
});

function respondJson(body: unknown, status = 200): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Test',
    json: async () => body,
  } as Response);
}

// ── loop.started: dispatch ───────────────────────────────────────────────────

describe('dispatchAgentRun bridges loop.started', () => {
  it('passes explicit metadata refs without deriving issue numbers from the prompt', async () => {
    respondJson({
      run_id: RUN_ID, state: 'QUEUED', session_id: 'session',
      trigger_url: 'https://github.com/o/r/issues/1',
      artifacts: [{ artifact_type: 'PULL_REQUEST', data: { url: 'https://github.com/o/r/pull/2' } }],
    });
    await dispatchAgentRun(PRINCIPAL, { prompt: 'Untrusted prose: issue #999' });
    await vi.waitFor(() => expect(emitWarpRunLoopEventMock).toHaveBeenCalled());
    expect(emitWarpRunLoopEventMock.mock.calls[0][0].refs).toEqual({
      runId: RUN_ID, sessionKey: 'session', issue: 'https://github.com/o/r/issues/1', pr: 'https://github.com/o/r/pull/2',
    });
    expect(emitWarpRunLoopEventMock.mock.calls[0][0].prArtifacts).toEqual(['https://github.com/o/r/pull/2']);
  });
  it('emits loop.started with loopId = runId, state = queued, and the Warp-confirmed parent lineage', async () => {
    respondJson({ run_id: RUN_ID, state: 'QUEUED', parent_run_id: 'run-parent-1' });

    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });
    await vi.waitFor(() => expect(emitWarpRunLoopEventMock).toHaveBeenCalled());

    expect(loopEventsOfType('loop.started')).toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        principalDid: PRINCIPAL,
        parentRunId: 'run-parent-1',
        state: 'queued',
      }),
    ]);
  });

  it('carries a null parentRunId when Warp reports none', async () => {
    respondJson({ run_id: RUN_ID, state: 'QUEUED' });

    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });
    await vi.waitFor(() => expect(emitWarpRunLoopEventMock).toHaveBeenCalled());

    expect(loopEventsOfType('loop.started')[0]).toMatchObject({ parentRunId: null });
  });

  it('reports the accepted run id when its required brief event cannot commit', async () => {
    emitWarpRunLoopEventMock.mockRejectedValue(new Error('loop rail unavailable'));
    respondJson({ run_id: RUN_ID, state: 'QUEUED' });

    await expect(dispatchAgentRun(PRINCIPAL, { prompt: 'go' })).rejects.toThrow(`warp_brief_event_failed: run ${RUN_ID}`);
  });
});

// ── loop.started (new segment): resume case ──────────────────────────────────

describe('sendFollowup resume bridges a fresh loop.started segment', () => {
  it('carries a distinct hash-only record for dispatch, follow-up and resume on the same run', async () => {
    vi.mocked(recordWarpBrief).mockImplementation(async (_did, text) => ({
      hash: createHash('sha256').update(text).digest('hex'), assetId: null,
      storage: 'hash-only', browserTesting: 'no',
    }));
    respondJson({ run_id: RUN_ID, state: 'QUEUED' });
    await dispatchAgentRun(PRINCIPAL, { prompt: 'first' });
    respondJson({ run_id: RUN_ID, state: 'INPROGRESS' });
    respondJson({});
    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'second' });
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED' });
    respondJson({});
    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'third', resume: true });
    const events = emitWarpRunLoopEventMock.mock.calls.map(([event]) => event);
    expect(events.map(event => event.type)).toEqual(['loop.started', 'loop.progress', 'loop.started']);
    expect(events.map(event => event.brief?.hash)).toEqual(['first', 'second', 'third'].map(
      text => createHash('sha256').update(text).digest('hex'),
    ));
    expect(events.every(event => event.brief?.assetId === null && event.runId === RUN_ID)).toBe(true);
  });
  it('uses only a confirmed new session id on resume', async () => {
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED', session_id: 'old-session' });
    respondJson({ session_id: 'new-session' });
    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'continue', resume: true });
    expect(emitWarpRunLoopEventMock.mock.calls[0][0].refs).toEqual({ sessionKey: 'new-session' });
  });
  it('emits loop.started (not loop.progress/finished) for a resumed terminal run, carrying its lineage', async () => {
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED', parent_run_id: 'run-parent-1' });
    respondJson({});

    const ack = await sendFollowup(PRINCIPAL, RUN_ID, { message: 'keep going', resume: true });

    expect(ack.resumed).toBeDefined();
    expect(loopEventsOfType('loop.started')).toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        principalDid: PRINCIPAL,
        parentRunId: 'run-parent-1',
        state: 'running',
      }),
    ]);
    expect(loopEventsOfType('loop.progress')).toHaveLength(0);
    expect(loopEventsOfType('loop.finished')).toHaveLength(0);
  });

  it('records an ordinary follow-up with its own descriptor on loop.progress', async () => {
    respondJson({ run_id: RUN_ID, state: 'INPROGRESS' });
    respondJson({});

    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'carry on' });

    expect(emitWarpRunLoopEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'loop.progress', brief: expect.objectContaining({ hash: 'a'.repeat(64) }),
    }));
  });
});

// ── watchRun: progress / blocked / terminal ──────────────────────────────────

describe('watchRun bridges progress, blocked, and terminal transitions', () => {
  function sleep(): Promise<void> {
    return Promise.resolve();
  }

  it('emits loop.progress alongside every warp.run.progress, with the same summary/state', async () => {
    // First poll: INPROGRESS (progress). Second poll: SUCCEEDED (terminal) — stop the loop.
    let call = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (url: string) => {
      if (String(url).endsWith('/conversation')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ conversation_id: 'c1', steps: [] }) } as Response;
      }
      call += 1;
      const state = call === 1 ? 'INPROGRESS' : 'SUCCEEDED';
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ run_id: RUN_ID, state }) } as Response;
    });

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const progress = loopEventsOfType('loop.progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ runId: RUN_ID, principalDid: PRINCIPAL, state: 'running' });
  });

  it('emits loop.blocked exactly once even though the run stays BLOCKED across several polls (idempotent)', async () => {
    let call = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (url: string) => {
      if (String(url).endsWith('/conversation')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ conversation_id: 'c1', steps: [] }) } as Response;
      }
      call += 1;
      const state = call <= 2 ? 'BLOCKED' : 'SUCCEEDED';
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ run_id: RUN_ID, state }) } as Response;
    });

    await watchRun(PRINCIPAL, RUN_ID, { sleep, progress: false });

    expect(loopEventsOfType('loop.blocked')).toHaveLength(1);
    expect(loopEventsOfType('loop.blocked')[0]).toMatchObject({
      runId: RUN_ID,
      principalDid: PRINCIPAL,
      state: 'blocked',
    });
  });

  it('emits loop.finished with state succeeded on a clean SUCCEEDED terminal', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ run_id: RUN_ID, state: 'SUCCEEDED', parent_run_id: 'run-parent-1' }),
    } as Response);

    await watchRun(PRINCIPAL, RUN_ID, { sleep, progress: false });

    expect(loopEventsOfType('loop.finished')).toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        principalDid: PRINCIPAL,
        parentRunId: 'run-parent-1',
        state: 'succeeded',
      }),
    ]);
  });

  it('emits loop.finished with state failed on a FAILED terminal', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ run_id: RUN_ID, state: 'FAILED' }),
    } as Response);

    await watchRun(PRINCIPAL, RUN_ID, { sleep, progress: false });

    expect(loopEventsOfType('loop.finished')).toEqual([
      expect.objectContaining({ runId: RUN_ID, principalDid: PRINCIPAL, state: 'failed' }),
    ]);
  });

  // ── Idempotency: the terminal-publish claim race (#2043) ───────────────────

  it('is idempotent: never bridges loop.finished when the terminal-publish claim was already won elsewhere', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ run_id: RUN_ID, state: 'SUCCEEDED' }),
    } as Response);

    await watchRun(PRINCIPAL, RUN_ID, {
      sleep,
      progress: false,
      claimTerminalPublish: async () => false, // another watch/sweep already claimed this segment
    });

    expect(publishMock).not.toHaveBeenCalledWith('warp.run.completed', expect.anything());
    expect(emitWarpRunLoopEventMock).not.toHaveBeenCalled();
  });

  it('replaying the same terminal read twice (claim won once, lost the second time) bridges loop.finished exactly once', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ run_id: RUN_ID, state: 'SUCCEEDED' }),
    } as Response);

    let claimed = false;
    const claimTerminalPublish = async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    };

    await watchRun(PRINCIPAL, RUN_ID, { sleep, progress: false, claimTerminalPublish });
    await watchRun(PRINCIPAL, RUN_ID, { sleep, progress: false, claimTerminalPublish });

    expect(loopEventsOfType('loop.finished')).toHaveLength(1);
  });
});

// ── loop.finished: timeout ────────────────────────────────────────────────────

describe('publishTimeoutRunOutcome bridges loop.finished with state timeout', () => {
  it('emits loop.finished(state: timeout) alongside warp.run.timeout', async () => {
    await publishTimeoutRunOutcome(PRINCIPAL, RUN_ID, 'INPROGRESS');

    expect(publishMock).toHaveBeenCalledWith('warp.run.timeout', expect.anything());
    expect(loopEventsOfType('loop.finished')).toEqual([
      expect.objectContaining({ runId: RUN_ID, principalDid: PRINCIPAL, state: 'timeout' }),
    ]);
  });
});
