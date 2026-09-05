/**
 * Tests for the Warp run watch (#1639, Stage 3; #1682).
 *
 * The watch is driven through the real `getAgentRun` / `getAgentRunConversation`
 * read paths with `fetch` mocked, so these pin the poll schedule, the
 * terminal-state detection, the mid-run progress deltas, and the shape of the
 * bus events a listener will actually receive.
 *
 * Two things are injected rather than faked globally:
 *   - `sleep`, which records the gap it was asked for and advances a stubbed
 *     `Date.now` by exactly that much. The schedule and the 30-minute budget are
 *     therefore asserted on in wall-clock terms while the suite runs instantly.
 *   - nothing else. `WATCH_POLL_INTERVALS_MS` and `WATCH_TIMEOUT_MS` are the real
 *     production values here, so a change to either breaks these tests rather
 *     than sliding past them.
 *
 * `fetch` is answered by URL rather than by call order: the watch makes two
 * different reads per cycle now, and an order-based queue would let a
 * conversation read silently eat a run response.
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

interface StubbedResponse {
  body: unknown;
  status: number;
}

/** Answers pulled in order, then held at the fallback once the queue is empty. */
interface ResponseLane {
  queue: StubbedResponse[];
  fallback: StubbedResponse | null;
  reads: number;
}

let runLane: ResponseLane;
let conversationLane: ResponseLane;

function takeFrom(lane: ResponseLane): StubbedResponse {
  lane.reads += 1;
  const next = lane.queue.shift() ?? lane.fallback;
  if (next === null || next === undefined) {
    throw new Error('the watch made more reads than the test queued answers for');
  }
  return next;
}

function asResponse({ body, status }: StubbedResponse): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Test',
    json: async () => body,
  } as Response;
}

/**
 * Route a read to its lane.
 *
 * The run read and the conversation read differ only by the path suffix, which
 * is all the discrimination the watch's two calls per cycle need.
 */
function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      asResponse(takeFrom(String(url).endsWith('/conversation') ? conversationLane : runLane)),
    ),
  );
}

/** Queue one `GET /agent/runs/{id}` answer. */
function respondRun(body: unknown, status = 200): void {
  runLane.queue.push({ body, status });
}

/** Answer every remaining run read the same way. */
function respondRunAlways(body: unknown, status = 200): void {
  runLane.fallback = { body, status };
}

/** Queue one `GET /agent/runs/{id}/conversation` answer. */
function respondConversation(steps: unknown[], status = 200): void {
  conversationLane.queue.push({ body: { conversation_id: 'c1', steps }, status });
}

/** Answer every remaining conversation read the same way. */
function respondConversationAlways(steps: unknown[], status = 200): void {
  conversationLane.fallback = { body: { conversation_id: 'c1', steps }, status };
}

function runBody(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { run_id: RUN_ID, state, ...extra };
}

function step(id: string, messages: unknown[], nested: unknown[] = []): Record<string, unknown> {
  return { id, messages, steps: nested };
}

function textMessage(role: string, text: string): Record<string, unknown> {
  return { role, content: [{ type: 'text', text }] };
}

function actionMessage(name: string): Record<string, unknown> {
  return { role: 'tool', content: [{ type: 'action', category: 'COMMAND', name, input: {} }] };
}

interface PublishedEvent {
  type: string;
  issuer: string;
  subject: string;
  scope: string;
  payload: Record<string, unknown>;
}

function publishedEvents(): PublishedEvent[] {
  return publishMock.mock.calls.map(
    ([type, event]: [
      string,
      { issuer: string; subject: string; scope: string; payload: Record<string, unknown> },
    ]) => ({ type, ...event }),
  );
}

function eventsOfType(type: string): PublishedEvent[] {
  return publishedEvents().filter((event) => event.type === type);
}

/** The first event of `type` the watch published, or a failure if it published none. */
function eventOfType(type: string): PublishedEvent {
  const [event] = eventsOfType(type);
  if (event === undefined) {
    const seen = publishedEvents().map((e) => e.type).join(', ');
    throw new Error(`no ${type} published; saw [${seen}]`);
  }
  return event;
}

function progressEvents(): PublishedEvent[] {
  return eventsOfType('warp.run.progress');
}

/** Run reads only — the conversation lane is counted separately. */
function readCount(): number {
  return runLane.reads;
}

function conversationReadCount(): number {
  return conversationLane.reads;
}

beforeEach(() => {
  process.env.WARP_API_BASE_URL = BASE_URL;

  slept = [];
  clockMs = 1_760_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clockMs);

  runLane = { queue: [], fallback: null, reads: 0 };
  // A run whose conversation is not explicitly stubbed simply has nothing in it
  // yet, which is the common case for the terminal-state tests.
  conversationLane = {
    queue: [],
    fallback: { body: { conversation_id: 'c1', steps: [] }, status: 200 },
    reads: 0,
  };

  requireAgentKeyMock.mockReset().mockResolvedValue(AGENT_KEY);
  lookupIdentityMock.mockReset().mockResolvedValue({ did: PRINCIPAL, handle: 'veteze' });
  publishMock.mockReset().mockResolvedValue(undefined);
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();

  readEnvironmentIdMock.mockReset();
  getNodeDidMock.mockReset();

  installFetch();
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

    const event = eventOfType('warp.run.completed');
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

    expect(eventOfType('warp.run.completed').payload.artifacts).toEqual([
      {
        type: 'PULL_REQUEST',
        url: 'https://github.com/ima-jin/imajin-ai/pull/1638',
        branch: 'fix/1630',
      },
      { type: 'PLAN', url: null, branch: null },
      { type: 'UNKNOWN', url: 'https://example.test/thing', branch: null },
    ]);
  });

  it('publishes warp.run.failed, not warp.run.completed, carrying the failure reason (#1838)', async () => {
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

    expect(eventOfType('warp.run.failed').payload).toMatchObject({
      state: 'FAILED',
      statusMessage: {
        message: 'Team has no remaining add-on credits',
        errorCode: 'insufficient_credits',
        retryable: false,
      },
      // Flat scalar for the notify reactor's `{{summary}}` substitution — prefers
      // Warp's own error code over the free-text message.
      summary: 'insufficient_credits',
    });
    expect(typeof eventOfType('warp.run.failed').payload.failedAt).toBe('string');
    // FAILED is no longer part of warp.run.completed's own state space.
    expect(eventsOfType('warp.run.completed')).toHaveLength(0);
  });

  it('treats CANCELLED as an ending rather than watching it for another 30 minutes', async () => {
    respondRun(runBody('CANCELLED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(eventOfType('warp.run.completed').payload).toMatchObject({ state: 'CANCELLED' });
    expect(readCount()).toBe(1);
  });

  it('keeps watching a BLOCKED run, which is waiting on a human rather than finished', async () => {
    respondRun(runBody('BLOCKED'));
    respondRun(runBody('BLOCKED'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(readCount()).toBe(3);
    expect(eventOfType('warp.run.completed').payload).toMatchObject({ state: 'SUCCEEDED' });
  });

  it('publishes warp.run.blocked the moment BLOCKED is observed, exactly once (#1838)', async () => {
    respondRun(
      runBody('BLOCKED', {
        title: 'Nightly',
        status_message: { message: 'Waiting on repo access', error_code: null, retryable: null },
      }),
    );
    respondRun(runBody('BLOCKED'));
    respondRun(runBody('BLOCKED'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    // Not gated behind the 30-minute timeout budget — this fires on the very
    // first poll that observes BLOCKED.
    expect(eventsOfType('warp.run.blocked')).toHaveLength(1);
    const [blocked] = eventsOfType('warp.run.blocked');
    expect(blocked.issuer).toBe(PRINCIPAL);
    expect(blocked.subject).toBe(PRINCIPAL);
    expect(blocked.scope).toBe('warp');
    expect(blocked.payload).toMatchObject({
      runId: RUN_ID,
      state: 'BLOCKED',
      title: 'Nightly',
      summary: 'Waiting on repo access',
      statusMessage: { message: 'Waiting on repo access', errorCode: null, retryable: null },
      principalDid: PRINCIPAL,
      context_id: RUN_ID,
      context_type: 'warp.agent',
    });
    expect(typeof blocked.payload.blockedAt).toBe('string');
    // The run eventually resolves, and the ending is still reported normally.
    expect(eventOfType('warp.run.completed').payload).toMatchObject({ state: 'SUCCEEDED' });
  });

  it('does not publish warp.run.blocked when progress reporting is turned off (#1838)', async () => {
    respondRun(runBody('BLOCKED'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep, progress: false });

    // warp.run.blocked is not progress telemetry, so it still fires even when
    // `progress: false` disables warp.run.progress.
    expect(eventsOfType('warp.run.blocked')).toHaveLength(1);
  });

  it('publishes exactly one event and stops reading once terminal', async () => {
    respondRunAlways(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(readCount()).toBe(1);
  });
});

// ── Watch budget elapsed: still running, NOT a timeout (#2032) ──────────────────────────────

describe('watch budget elapsed', () => {
  it('gives up after 30 minutes and says so as still running, never as a timeout', async () => {
    respondRunAlways(runBody('INPROGRESS'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const event = eventOfType('warp.run.still_running');
    expect(event.payload).toMatchObject({
      runId: RUN_ID,
      state: 'INPROGRESS',
      principalDid: PRINCIPAL,
      watchBudgetMs: WATCH_TIMEOUT_MS,
      context_id: RUN_ID,
      context_type: 'warp.agent',
    });
    expect(typeof event.payload.observedAt).toBe('string');
    expect(typeof event.payload.elapsedMs).toBe('number');
    // The whole point of #2032: a run that later succeeds must never have been
    // told it timed out.
    expect(eventsOfType('warp.run.timeout')).toHaveLength(0);
  });

  it('spends exactly the budget, never overshooting the final interval', async () => {
    respondRunAlways(runBody('INPROGRESS'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(WATCH_TIMEOUT_MS).toBe(30 * 60 * 1_000);
    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(WATCH_TIMEOUT_MS);
    expect(Math.max(...slept)).toBeLessThanOrEqual(60_000);
    expect(eventsOfType('warp.run.still_running')).toHaveLength(1);
    expect(eventsOfType('warp.run.timeout')).toHaveLength(0);
    // A run that never moves reports its first sighting and then stays quiet for
    // the rest of the budget, so the still-running event is not competing with
    // poll noise.
    expect(progressEvents()).toHaveLength(1);
  });

  it('reports UNKNOWN when the budget is gone before the first read', async () => {
    respondRunAlways(runBody('INPROGRESS'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep, timeoutMs: 0 });

    expect(eventOfType('warp.run.still_running').payload).toMatchObject({ state: 'UNKNOWN' });
    expect(readCount()).toBe(0);
  });

  it('exactly one warp.run.completed and zero warp.run.timeout when the run later succeeds (#2032 acceptance)', async () => {
    respondRun(runBody('INPROGRESS')); // budget elapses before a read happens (timeoutMs: 0)
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep, timeoutMs: 0 });
    // The in-request watch only ever gets one shot at its own budget; a second
    // watch (standing in for the sweep's own later re-check, which uses the
    // same publish functions — see run-watch-sweep.test.ts for the real sweep
    // path) is what observes the eventual terminal state.
    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(eventsOfType('warp.run.still_running')).toHaveLength(1);
    expect(eventsOfType('warp.run.completed')).toHaveLength(1);
    expect(eventsOfType('warp.run.timeout')).toHaveLength(0);
  });
});

// ── Progress: state transitions (#1682) ───────────────────────────────────────

describe('state transitions', () => {
  it('publishes the first sighting and then the transition into INPROGRESS', async () => {
    respondRun(runBody('QUEUED'));
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const [first, second] = progressEvents();
    expect(first.issuer).toBe(PRINCIPAL);
    expect(first.subject).toBe(PRINCIPAL);
    expect(first.scope).toBe('warp');
    expect(first.payload).toMatchObject({
      runId: RUN_ID,
      principalDid: PRINCIPAL,
      state: 'QUEUED',
      // The first sighting has nothing to transition from.
      previousState: null,
      changed: ['state'],
      summary: 'QUEUED',
      pollCount: 1,
      context_id: RUN_ID,
      context_type: 'warp.agent',
    });
    expect(typeof first.payload.observedAt).toBe('string');

    expect(second.payload).toMatchObject({
      state: 'INPROGRESS',
      previousState: 'QUEUED',
      changed: ['state'],
      summary: 'QUEUED → INPROGRESS',
      pollCount: 2,
    });
  });

  it('does not publish progress for the terminal read, which the completion covers', async () => {
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(progressEvents().map((event) => event.payload.state)).toEqual(['INPROGRESS']);
    expect(eventsOfType('warp.run.completed')).toHaveLength(1);
  });

  it('stays silent on a poll where nothing moved', async () => {
    respondRun(runBody('QUEUED'));
    respondRun(runBody('QUEUED'));
    respondRun(runBody('QUEUED'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(progressEvents()).toHaveLength(1);
  });

  it('can be turned off entirely, leaving the terminal event alone', async () => {
    respondRun(runBody('QUEUED'));
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep, progress: false });

    expect(progressEvents()).toHaveLength(0);
    expect(conversationReadCount()).toBe(0);
    expect(eventsOfType('warp.run.completed')).toHaveLength(1);
  });
});

// ── Progress: conversation deltas (#1682) ─────────────────────────────────────

describe('conversation deltas', () => {
  it('skips the conversation read while the run is still queued', async () => {
    respondRun(runBody('QUEUED'));
    respondRun(runBody('QUEUED'));
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    // One read, for the single INPROGRESS poll — the two QUEUED polls made none.
    expect(conversationReadCount()).toBe(1);
  });

  it('publishes only the messages that appeared since the last poll', async () => {
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));
    respondConversation([step('step-1', [textMessage('assistant', 'working')])]);
    respondConversation([
      step('step-1', [textMessage('assistant', 'working'), actionMessage('run_command')]),
    ]);

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const [first, second] = progressEvents();
    expect(first.payload).toMatchObject({
      changed: ['state', 'messages'],
      newMessageCount: 1,
      totalMessageCount: 1,
    });
    expect(first.payload.newMessages).toEqual([
      {
        index: 0,
        stepId: 'step-1',
        role: 'assistant',
        blockTypes: ['text'],
        actions: [],
        text: 'working',
      },
    ]);

    // The message already reported is not reported again.
    expect(second.payload).toMatchObject({
      changed: ['messages'],
      summary: '1 new message',
      newMessageCount: 1,
      totalMessageCount: 2,
    });
    expect(second.payload.newMessages).toEqual([
      {
        index: 1,
        stepId: 'step-1',
        role: 'tool',
        blockTypes: ['action'],
        actions: ['run_command'],
        text: null,
      },
    ]);
  });

  it('walks nested steps depth-first, so a delegated step keeps its place', async () => {
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));
    respondConversation([
      step(
        'step-1',
        [textMessage('assistant', 'delegating')],
        [step('step-1a', [textMessage('assistant', 'child work')])],
      ),
      step('step-2', [textMessage('assistant', 'back on top')]),
    ]);

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const carried = progressEvents()[0].payload.newMessages as Array<Record<string, unknown>>;
    expect(carried.map((message) => [message.index, message.stepId, message.text])).toEqual([
      [0, 'step-1', 'delegating'],
      [1, 'step-1a', 'child work'],
      [2, 'step-2', 'back on top'],
    ]);
  });

  it('keeps the most recent messages when a burst exceeds the cap, but counts them all', async () => {
    const messages = Array.from({ length: 25 }, (_unused, index) =>
      textMessage('assistant', `message ${index}`),
    );
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));
    respondConversation([step('step-1', messages)]);

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const payload = progressEvents()[0].payload;
    const carried = payload.newMessages as Array<Record<string, unknown>>;
    expect(payload).toMatchObject({ newMessageCount: 25, totalMessageCount: 25 });
    expect(carried).toHaveLength(20);
    expect(carried[0].index).toBe(5);
    expect(carried.at(-1)).toMatchObject({ index: 24, text: 'message 24' });
  });

  it('truncates a long message rather than putting an unbounded body on the bus', async () => {
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));
    respondConversation([step('step-1', [textMessage('assistant', 'x'.repeat(2_000))])]);

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const [message] = progressEvents()[0].payload.newMessages as Array<{ text: string }>;
    expect(message.text).toHaveLength(501);
    expect(message.text.endsWith('…')).toBe(true);
  });

  it('reports a message Warp sent without a role or block type rather than dropping it', async () => {
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));
    respondConversation([{ messages: [{ content: [{ text: 'orphan' }] }] }]);

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(progressEvents()[0].payload.newMessages).toEqual([
      {
        index: 0,
        stepId: null,
        role: 'unknown',
        blockTypes: ['unknown'],
        actions: [],
        text: 'orphan',
      },
    ]);
  });

  it('keeps watching, and still reports the state, when the conversation read fails', async () => {
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));
    respondConversationAlways([], 502);

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(progressEvents()[0].payload).toMatchObject({
      changed: ['state'],
      newMessages: [],
      newMessageCount: 0,
    });
    expect(eventsOfType('warp.run.completed')).toHaveLength(1);
    expect(logMock.warn).toHaveBeenCalled();
  });
});

// ── Progress: cost and early errors (#1682) ───────────────────────────────────

describe('cost accumulation', () => {
  it('publishes when the running spend moves, and not when it holds', async () => {
    respondRun(runBody('INPROGRESS', { request_usage: { inference_cost: 0.1 } }));
    respondRun(runBody('INPROGRESS', { request_usage: { inference_cost: 0.3 } }));
    respondRun(runBody('INPROGRESS', { request_usage: { inference_cost: 0.3 } }));
    respondRun(runBody('SUCCEEDED', { request_usage: { inference_cost: 0.4 } }));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const events = progressEvents();
    expect(events[0].payload).toMatchObject({
      changed: ['state', 'usage'],
      requestUsage: { inferenceCost: 0.1, computeCost: null, platformCost: null },
    });
    expect(events[1].payload).toMatchObject({
      changed: ['usage'],
      summary: 'cost updated',
      requestUsage: { inferenceCost: 0.3, computeCost: null, platformCost: null },
    });
    // The third poll reported the same cost, so it is not an event.
    expect(events).toHaveLength(2);
  });
});

describe('early signals', () => {
  it('surfaces a status message the moment it populates, not at the timeout', async () => {
    respondRun(
      runBody('INPROGRESS', {
        status_message: {
          message: 'Sandbox restarted',
          error_code: 'sandbox_restart',
          retryable: true,
        },
      }),
    );
    respondRunAlways(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const event = progressEvents()[0];
    expect(event.payload.changed).toEqual(['state', 'statusMessage']);
    expect(event.payload.statusMessage).toEqual({
      message: 'Sandbox restarted',
      errorCode: 'sandbox_restart',
      retryable: true,
    });
    // The error code is what the notification body leads with.
    expect(event.payload.summary).toBe('INPROGRESS; sandbox_restart');
    expect(readCount()).toBe(2);
  });

  it('reports an artifact that appears before the run ends', async () => {
    respondRun(
      runBody('INPROGRESS', {
        artifacts: [
          {
            artifact_type: 'PULL_REQUEST',
            data: { url: 'https://github.com/ima-jin/imajin-ai/pull/1683', branch: 'feat/1682' },
          },
        ],
      }),
    );
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    const event = progressEvents()[0];
    expect(event.payload.changed).toEqual(['state', 'artifacts']);
    expect(event.payload.artifacts).toEqual([
      {
        type: 'PULL_REQUEST',
        url: 'https://github.com/ima-jin/imajin-ai/pull/1683',
        branch: 'feat/1682',
      },
    ]);
  });
});

// ── Read failures ─────────────────────────────────────────────────────────────

describe('read failures', () => {
  it('retries a transient upstream failure and still reports the completion', async () => {
    respondRun({ title: 'Bad Gateway' }, 502);
    respondRun(runBody('SUCCEEDED'));

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(eventOfType('warp.run.completed')).toBeDefined();
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

  it('does not let a failed progress publish cost the completion event', async () => {
    publishMock.mockImplementation((type: string) =>
      type === 'warp.run.progress' ? Promise.reject(new Error('bus down')) : Promise.resolve(),
    );
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));

    await expect(watchRun(PRINCIPAL, RUN_ID, { sleep })).resolves.toBeUndefined();

    expect(eventsOfType('warp.run.completed')).toHaveLength(1);
    expect(logMock.warn).toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
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

  it('is absent from the progress events a live run publishes', async () => {
    respondRun(runBody('INPROGRESS'));
    respondRun(runBody('SUCCEEDED'));
    respondConversation([step('step-1', [textMessage('assistant', 'working')])]);

    await watchRun(PRINCIPAL, RUN_ID, { sleep });

    expect(progressEvents().length).toBeGreaterThan(0);
    expect(JSON.stringify(publishMock.mock.calls)).not.toContain(AGENT_KEY);
  });
});
