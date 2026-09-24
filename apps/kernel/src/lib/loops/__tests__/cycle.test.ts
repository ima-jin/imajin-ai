/**
 * Tests for the `cycle` loopKind (#2314): `startCycle` -> `cyclePhase` ->
 * `cycleChild` -> `finishCycle`, all mapped onto the existing
 * `loop.started|progress|blocked|finished` rail (#2295, PR #2302).
 *
 * `getNodeSigningIdentity`, `ingestLoopEvent`, and `getLoopWithHistory` are
 * mocked for the behavioural tests (asserting on the exact envelope shape
 * each call publishes, not on call counts), mirroring
 * `warp/__tests__/loop-emit.test.ts`'s structure. `@imajin/db`'s
 * `getClient()` is mocked with a fake tagged-template client (the
 * `packages/bus/AGENTS.md` / `query.test.ts` pattern) to drive the
 * fail-closed "unknown correlationId" and idempotent-replay paths.
 *
 * `cycle-signing-integration.test.ts` is the sibling file that does NOT
 * mock `ingestLoopEvent`/`verifyLoopPublisherSignature` — it proves the
 * signature `cycle.ts` produces actually verifies through the real rail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getNodeSigningIdentityMock, ingestLoopEventMock, getLoopWithHistoryMock, signSyncMock, canonicalizeMock, fakeSql, sqlCalls, logMock } =
  vi.hoisted(() => {
    const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
    const queue: unknown[][] = [];
    const fakeSql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        sqlCalls.push({ text: strings.join(' ? '), values });
        return Promise.resolve(queue.shift() ?? []);
      },
      { resolveWith: (rows: unknown[]) => queue.push(rows) },
    );
    return {
      getNodeSigningIdentityMock: vi.fn(),
      ingestLoopEventMock: vi.fn(),
      getLoopWithHistoryMock: vi.fn(),
      signSyncMock: vi.fn(),
      canonicalizeMock: vi.fn((value: unknown) => JSON.stringify(value)),
      fakeSql,
      sqlCalls,
      logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
  });

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: canonicalizeMock,
  crypto: { signSync: signSyncMock },
}));

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: getNodeSigningIdentityMock,
}));

vi.mock('../ingest', () => ({
  ingestLoopEvent: ingestLoopEventMock,
}));

vi.mock('../query', () => ({
  getLoopWithHistory: getLoopWithHistoryMock,
}));

import { startCycle, cyclePhase, cycleChild, finishCycle, CYCLE_LOOP_KIND } from '../cycle';

const NODE_IDENTITY = {
  privateKeyHex: 'a'.repeat(64),
  senderPubkey: 'B'.repeat(64), // uppercase on purpose — the module must lowercase it
  senderDid: 'did:imajin:node-witness',
};

const PRINCIPAL = 'did:imajin:ryan';
const CORRELATION_ID = 'cycle_abc123';

function resolveWithLoopRow() {
  fakeSql.resolveWith([{ principal: PRINCIPAL }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  getNodeSigningIdentityMock.mockReturnValue(NODE_IDENTITY);
  signSyncMock.mockReturnValue('CAFE'.repeat(32)); // 128 hex chars, uppercase on purpose
  ingestLoopEventMock.mockResolvedValue({ ok: true });
});

describe('startCycle', () => {
  it('publishes loop.started with kind=cycle, principal=onBehalfOf, and the planned phases', async () => {
    const result = await startCycle({
      principal: PRINCIPAL,
      trigger: 'chat',
      plannedPhases: ['merge-sweep', 'raise', 'provision', 'review', 'report'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.correlationId).toMatch(/^cycle_/);

    expect(ingestLoopEventMock).toHaveBeenCalledTimes(1);
    const [request] = ingestLoopEventMock.mock.calls[0] as [{ type: string; payload: Record<string, unknown>; publisherDid: string }];
    expect(request.type).toBe('loop.started');
    expect(request.publisherDid).toBe(NODE_IDENTITY.senderDid);
    expect(request.payload).toMatchObject({
      loopId: result.correlationId,
      kind: CYCLE_LOOP_KIND,
      principal: PRINCIPAL,
      parentLoopId: null,
      state: 'started',
      trigger: 'chat',
      plannedPhases: ['merge-sweep', 'raise', 'provision', 'review', 'report'],
    });
  });

  it('reports failure without throwing when ingest rejects the event', async () => {
    ingestLoopEventMock.mockResolvedValue({ ok: false, error: 'Invalid publisher signature', status: 400 });

    const result = await startCycle({ principal: PRINCIPAL, trigger: 'mcp', plannedPhases: ['raise'] });

    expect(result).toEqual({ ok: false, error: 'Invalid publisher signature' });
  });
});

describe('cyclePhase', () => {
  it('fails closed on an unknown correlationId without publishing anything', async () => {
    fakeSql.resolveWith([]); // no kernel.loops row for this loopId

    const result = await cyclePhase('cycle_never-started', 'raise', 'started', {});

    expect(result.ok).toBe(false);
    expect(ingestLoopEventMock).not.toHaveBeenCalled();
  });

  it('publishes loop.progress with state=phase and the phase/status/counts payload', async () => {
    resolveWithLoopRow();
    getLoopWithHistoryMock.mockResolvedValueOnce({ loop: {}, events: [] });

    const result = await cyclePhase(CORRELATION_ID, 'raise', 'completed', { candidates: 4, filed: 3, dedupedAgainst: ['#100'] });

    expect(result).toEqual({ ok: true });
    expect(ingestLoopEventMock).toHaveBeenCalledTimes(1);
    const [request] = ingestLoopEventMock.mock.calls[0] as [{ type: string; payload: Record<string, unknown> }];
    expect(request.type).toBe('loop.progress');
    expect(request.payload).toMatchObject({
      loopId: CORRELATION_ID,
      kind: CYCLE_LOOP_KIND,
      principal: PRINCIPAL,
      state: 'raise',
      phase: 'raise',
      phaseStatus: 'completed',
      counts: { candidates: 4, filed: 3, dedupedAgainst: ['#100'] },
    });
  });

  it('routes a blocked phase status to loop.blocked with state=blocked', async () => {
    resolveWithLoopRow();
    getLoopWithHistoryMock.mockResolvedValueOnce({ loop: {}, events: [] });

    const result = await cyclePhase(CORRELATION_ID, 'review', 'blocked', { needsDecision: 2 });

    expect(result).toEqual({ ok: true });
    const [request] = ingestLoopEventMock.mock.calls[0] as [{ type: string; payload: Record<string, unknown> }];
    expect(request.type).toBe('loop.blocked');
    expect(request.payload).toMatchObject({ state: 'blocked', phase: 'review', phaseStatus: 'blocked' });
  });

  it('is idempotent: replaying an identical (phase, status, counts) transition is a no-op', async () => {
    resolveWithLoopRow();
    getLoopWithHistoryMock.mockResolvedValueOnce({
      loop: {},
      events: [
        {
          type: 'loop.progress',
          payload: { phase: 'raise', phaseStatus: 'completed', counts: { candidates: 4, filed: 3 } },
        },
      ],
    });

    const result = await cyclePhase(CORRELATION_ID, 'raise', 'completed', { candidates: 4, filed: 3 });

    expect(result).toEqual({ ok: true });
    expect(ingestLoopEventMock).not.toHaveBeenCalled();
  });

  it('does not dedupe a genuinely different transition for the same phase', async () => {
    resolveWithLoopRow();
    getLoopWithHistoryMock.mockResolvedValueOnce({
      loop: {},
      events: [{ type: 'loop.progress', payload: { phase: 'raise', phaseStatus: 'started', counts: {} } }],
    });

    const result = await cyclePhase(CORRELATION_ID, 'raise', 'completed', { candidates: 4 });

    expect(result).toEqual({ ok: true });
    expect(ingestLoopEventMock).toHaveBeenCalledTimes(1);
  });
});

describe('cycleChild', () => {
  it('fails closed on an unknown correlationId', async () => {
    fakeSql.resolveWith([]);

    const result = await cycleChild('cycle_never-started', 'warp.run', 'run-123');

    expect(result.ok).toBe(false);
    expect(ingestLoopEventMock).not.toHaveBeenCalled();
  });

  it('links a warp.run child with refs.runId set and childKind/childId in the payload', async () => {
    resolveWithLoopRow();
    getLoopWithHistoryMock.mockResolvedValueOnce({ loop: {}, events: [] });

    const result = await cycleChild(CORRELATION_ID, 'warp.run', 'run-123');

    expect(result).toEqual({ ok: true });
    const [request] = ingestLoopEventMock.mock.calls[0] as [{ type: string; payload: Record<string, unknown> }];
    expect(request.type).toBe('loop.progress');
    expect(request.payload).toMatchObject({
      state: 'child-linked',
      childKind: 'warp.run',
      childId: 'run-123',
      refs: { runId: 'run-123' },
    });
  });

  it('links a subagent/review child without a refs.runId', async () => {
    resolveWithLoopRow();
    getLoopWithHistoryMock.mockResolvedValueOnce({ loop: {}, events: [] });

    const result = await cycleChild(CORRELATION_ID, 'review', 'review-agent-1');

    expect(result).toEqual({ ok: true });
    const [request] = ingestLoopEventMock.mock.calls[0] as [{ payload: Record<string, unknown> }];
    expect(request.payload.refs).toBeUndefined();
    expect(request.payload).toMatchObject({ childKind: 'review', childId: 'review-agent-1' });
  });

  it('is idempotent: linking the same (childKind, childId) twice is a no-op', async () => {
    resolveWithLoopRow();
    getLoopWithHistoryMock.mockResolvedValueOnce({
      loop: {},
      events: [{ type: 'loop.progress', payload: { state: 'child-linked', childKind: 'warp.run', childId: 'run-123' } }],
    });

    const result = await cycleChild(CORRELATION_ID, 'warp.run', 'run-123');

    expect(result).toEqual({ ok: true });
    expect(ingestLoopEventMock).not.toHaveBeenCalled();
  });
});

describe('finishCycle', () => {
  it('fails closed on an unknown correlationId', async () => {
    fakeSql.resolveWith([]);

    const result = await finishCycle('cycle_never-started', { status: 'completed', text: 'done' });

    expect(result.ok).toBe(false);
    expect(ingestLoopEventMock).not.toHaveBeenCalled();
  });

  it('publishes loop.finished with state=status and cardIds carried through', async () => {
    resolveWithLoopRow();
    getLoopWithHistoryMock.mockResolvedValueOnce({ loop: {}, events: [] });

    const result = await finishCycle(CORRELATION_ID, { status: 'completed', text: 'cycle complete: 3 PRs merged', cardIds: ['card_1', 'card_2'] });

    expect(result).toEqual({ ok: true });
    const [request] = ingestLoopEventMock.mock.calls[0] as [{ type: string; payload: Record<string, unknown> }];
    expect(request.type).toBe('loop.finished');
    expect(request.payload).toMatchObject({
      state: 'completed',
      summary: 'cycle complete: 3 PRs merged',
      cardIds: ['card_1', 'card_2'],
    });
  });

  it('is idempotent: a cycle that already has a loop.finished event is left alone', async () => {
    resolveWithLoopRow();
    getLoopWithHistoryMock.mockResolvedValueOnce({
      loop: {},
      events: [{ type: 'loop.finished', payload: { state: 'completed' } }],
    });

    const result = await finishCycle(CORRELATION_ID, { status: 'failed', text: 'retry attempt' });

    expect(result).toEqual({ ok: true });
    expect(ingestLoopEventMock).not.toHaveBeenCalled();
  });
});
