/**
 * Tests for the cycle MCP tools (#2316).
 *
 * `cycle_run` / `cycle_status` are a thin MCP surface over `../../loops/
 * cycle` (mocked here; its own rail-write semantics are covered by
 * `lib/loops/__tests__/cycle.test.ts`) and `../../decisions/emit`. What
 * matters at this layer is:
 *   - `cycle:run` gates both tools, checked via the real scope gate in
 *     server.ts AND the scope-manifest grant via `requireMcpGrant`;
 *   - `cycle_run` always stamps `ctx.did` as the cycle's `principal`, never
 *     a tool argument;
 *   - `cycle_run` validates `phases`/`scope` and normalizes `phases` back
 *     to the fixed cycle order regardless of the order supplied;
 *   - the phase-runner stub records a `skipped` rail transition per phase
 *     and, only in `dry_run`, raises a DecisionCard whose id is returned in
 *     `finishCycle`'s `cardIds`;
 *   - `cycle_status` resolves the caller's own most-recent cycle when
 *     `correlation_id` is omitted, fails closed (not_found) on a miss or a
 *     non-cycle loop, and folds phase/child events plus open card ids out
 *     of the loop history.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockRequireMcpGrant = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockResolveActiveMcpGrant = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock('../mcp-grant', () => ({
  requireMcpGrant: mockRequireMcpGrant,
  resolveActiveMcpGrant: mockResolveActiveMcpGrant,
}));

const mockStartCycle = vi.hoisted(() => vi.fn());
const mockCyclePhase = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const mockFinishCycle = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
// Not `importActual`: the real module transitively pulls in `@imajin/db`
// (via `./query`/`./verify-publisher-signature`), which throws without a
// live `DATABASE_URL`. `CYCLE_PHASES`/`CYCLE_LOOP_KIND`/`isCyclePhaseName`
// are pure vocabulary, so they're safe to re-declare verbatim here rather
// than pull in the DB-touching half of the module just to re-export them.
vi.mock('../../loops/cycle', () => {
  const CYCLE_PHASES = ['merge-sweep', 'raise', 'provision', 'review', 'report'] as const;
  return {
    CYCLE_PHASES,
    CYCLE_LOOP_KIND: 'cycle',
    isCyclePhaseName: (value: unknown): boolean => typeof value === 'string' && (CYCLE_PHASES as readonly string[]).includes(value),
    startCycle: mockStartCycle,
    cyclePhase: mockCyclePhase,
    finishCycle: mockFinishCycle,
  };
});

const mockGetLoopWithHistory = vi.hoisted(() => vi.fn());
const mockListLoopsPage = vi.hoisted(() => vi.fn());
vi.mock('../../loops/query', () => ({
  getLoopWithHistory: mockGetLoopWithHistory,
  listLoopsPage: mockListLoopsPage,
}));

const mockEmitDecisionCard = vi.hoisted(() => vi.fn());
// Not `importActual`: the real module pulls in the DB-backed operator-
// approvals service at load time (same DATABASE_URL problem as above).
vi.mock('../../decisions/emit', () => ({
  DECISION_APPROVAL_SOURCE: 'decision',
  emitDecisionCard: mockEmitDecisionCard,
}));

const mockGetOperatorDid = vi.hoisted(() => vi.fn().mockResolvedValue('did:imajin:operator'));
vi.mock('../../notify/operator-approvals', () => ({
  getOperatorDid: mockGetOperatorDid,
}));

const mockListApprovalsForOperator = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../../notify/operator-approvals-service', () => ({
  listApprovalsForOperator: mockListApprovalsForOperator,
}));

// Swap the registry for the real cycle tools only, so the scope gate in
// server.ts runs against them without loading every other (DB-backed) tool
// module (same technique as loops-tools.test.ts / corpus-tools.test.ts).
vi.mock('../tools', async () => {
  const { cycleTools } = await import('../tools/cycle');
  const byName = new Map(cycleTools.map((t) => [t.name, t]));
  return { ALL_TOOLS: cycleTools, toolByName: (n: string) => byName.get(n) };
});

import { handleMcpRpc } from '../server';
import { cycleTools } from '../tools/cycle';

// ─── Helpers ───────────────────────────────────────────────────────────────

function tool(name: string) {
  const t = cycleTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function ctxFor(did: string): McpToolContext {
  return { did, appDid: 'did:imajin:mcp-connector', scopes: new Set(['cycle:run']) };
}

async function call(name: string, args: Record<string, unknown>, ctx: McpToolContext): Promise<McpContent[]> {
  return (await tool(name).handler(args, ctx)) as McpContent[];
}

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

function callViaGate(name: string, scopes: string[], args: Record<string, unknown> = {}) {
  const ctx = ctxFor('did:imajin:alice');
  ctx.scopes = new Set(scopes);
  return handleMcpRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  ) as Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMcpGrant.mockResolvedValue(undefined);
  mockResolveActiveMcpGrant.mockResolvedValue(false);
  mockGetOperatorDid.mockResolvedValue('did:imajin:operator');
  mockListApprovalsForOperator.mockResolvedValue([]);
  mockCyclePhase.mockResolvedValue({ ok: true });
  mockFinishCycle.mockResolvedValue({ ok: true });
  mockStartCycle.mockResolvedValue({ ok: true, correlationId: 'cycle_abc' });
  mockGetLoopWithHistory.mockResolvedValue(null);
  mockListLoopsPage.mockResolvedValue({ loops: [], hasNextPage: false, nextCursor: null });
});

// ─── Registration ────────────────────────────────────────────────────────────

describe('cycle tool registration', () => {
  it('exports cycle_run and cycle_status', () => {
    expect(cycleTools.map((t) => t.name)).toEqual(['cycle_run', 'cycle_status']);
  });

  it('gates both tools on cycle:run', () => {
    expect(tool('cycle_run').requiredScope).toBe('cycle:run');
    expect(tool('cycle_status').requiredScope).toBe('cycle:run');
  });

  it('rejects unknown arguments on both tool schemas (fail-closed)', () => {
    for (const t of cycleTools) {
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });
});

// ─── cycle_run — happy path ──────────────────────────────────────────────────

describe('cycle_run', () => {
  it('stamps ctx.did as principal and defaults to all five phases, in fixed order', async () => {
    const out = parseResult(await call('cycle_run', {}, ctxFor('did:imajin:alice')));

    expect(mockStartCycle).toHaveBeenCalledWith({
      principal: 'did:imajin:alice',
      trigger: 'mcp',
      plannedPhases: ['merge-sweep', 'raise', 'provision', 'review', 'report'],
    });
    expect(out).toEqual({ correlationId: 'cycle_abc' });
  });

  it('checks the scope-manifest grant before starting', async () => {
    await call('cycle_run', {}, ctxFor('did:imajin:alice'));

    expect(mockRequireMcpGrant).toHaveBeenCalledWith('did:imajin:alice', 'cycle:run', 'did:imajin:mcp-connector');
  });

  it('never lets a tool argument override the acting principal', async () => {
    await call(
      'cycle_run',
      { principal: 'did:imajin:mallory' } as Record<string, unknown>,
      ctxFor('did:imajin:bob'),
    );

    expect(mockStartCycle).toHaveBeenCalledWith(expect.objectContaining({ principal: 'did:imajin:bob' }));
  });

  it('normalizes a caller-supplied phases subset back to the fixed cycle order', async () => {
    await call('cycle_run', { phases: ['report', 'merge-sweep'] }, ctxFor('did:imajin:alice'));

    expect(mockStartCycle).toHaveBeenCalledWith(
      expect.objectContaining({ plannedPhases: ['merge-sweep', 'report'] }),
    );
  });

  it('rejects an unknown phase name without starting a cycle', async () => {
    await expect(
      call('cycle_run', { phases: ['not-a-real-phase'] }, ctxFor('did:imajin:alice')),
    ).rejects.toThrow(/unknown phase name/);
    expect(mockStartCycle).not.toHaveBeenCalled();
  });

  it('rejects a scope object missing repo', async () => {
    await expect(
      call('cycle_run', { scope: { labels: ['bug'] } }, ctxFor('did:imajin:alice')),
    ).rejects.toThrow(/scope.repo is required/);
    expect(mockStartCycle).not.toHaveBeenCalled();
  });

  it('accepts a well-formed scope and forwards it to the phase stub as counts', async () => {
    await call(
      'cycle_run',
      { phases: ['merge-sweep'], scope: { repo: 'ima-jin/imajin-ai', labels: ['bug'], issues: [42] } },
      ctxFor('did:imajin:alice'),
    );

    expect(mockCyclePhase).toHaveBeenCalledWith(
      'cycle_abc',
      'merge-sweep',
      'skipped',
      expect.objectContaining({ scope: { repo: 'ima-jin/imajin-ai', labels: ['bug'], issues: [42] } }),
    );
  });

  it('surfaces a startCycle failure without recording any phase transitions', async () => {
    mockStartCycle.mockResolvedValueOnce({ ok: false, error: 'rail unavailable' });

    await expect(call('cycle_run', {}, ctxFor('did:imajin:alice'))).rejects.toThrow(/rail unavailable/);
    expect(mockCyclePhase).not.toHaveBeenCalled();
    expect(mockFinishCycle).not.toHaveBeenCalled();
  });

  // ─── the phase-runner stub (#2316: no hidden actions) ───────────────────

  it('records every requested phase as skipped on the rail — never a silent no-op', async () => {
    await call('cycle_run', { phases: ['merge-sweep', 'report'] }, ctxFor('did:imajin:alice'));

    expect(mockCyclePhase).toHaveBeenCalledTimes(2);
    expect(mockCyclePhase).toHaveBeenNthCalledWith(
      1,
      'cycle_abc',
      'merge-sweep',
      'skipped',
      expect.objectContaining({ dryRun: false, reason: expect.stringContaining('phase runner not implemented') }),
    );
    expect(mockCyclePhase).toHaveBeenNthCalledWith(
      2,
      'cycle_abc',
      'report',
      'skipped',
      expect.objectContaining({ dryRun: false }),
    );
  });

  it('does not raise a DecisionCard when dry_run is false', async () => {
    await call('cycle_run', { phases: ['merge-sweep'] }, ctxFor('did:imajin:alice'));

    expect(mockEmitDecisionCard).not.toHaveBeenCalled();
    expect(mockFinishCycle).toHaveBeenCalledWith('cycle_abc', expect.objectContaining({ cardIds: [] }));
  });

  it('raises one DecisionCard per phase in dry_run and collects the ids into finishCycle', async () => {
    mockEmitDecisionCard
      .mockResolvedValueOnce({ ok: true, proposalId: 'dcard_1', card: {}, prose: '' })
      .mockResolvedValueOnce({ ok: true, proposalId: 'dcard_2', card: {}, prose: '' });

    await call('cycle_run', { phases: ['merge-sweep', 'report'], dry_run: true }, ctxFor('did:imajin:alice'));

    expect(mockEmitDecisionCard).toHaveBeenCalledTimes(2);
    const firstCall = mockEmitDecisionCard.mock.calls[0][0];
    expect(firstCall.correlationId).toBe('cycle_abc');
    expect(firstCall.evidence.authority.canActWithoutHuman).toBe(false);

    expect(mockCyclePhase).toHaveBeenNthCalledWith(
      1,
      'cycle_abc',
      'merge-sweep',
      'skipped',
      expect.objectContaining({ dryRun: true, cardId: 'dcard_1' }),
    );
    expect(mockFinishCycle).toHaveBeenCalledWith('cycle_abc', expect.objectContaining({ cardIds: ['dcard_1', 'dcard_2'] }));
  });

  it('still records the skip transition when the DecisionCard itself fails to emit', async () => {
    mockEmitDecisionCard.mockResolvedValueOnce({ ok: false, error: 'no operator configured' });

    await call('cycle_run', { phases: ['merge-sweep'], dry_run: true }, ctxFor('did:imajin:alice'));

    expect(mockCyclePhase).toHaveBeenCalledWith(
      'cycle_abc',
      'merge-sweep',
      'skipped',
      expect.not.objectContaining({ cardId: expect.anything() }),
    );
    expect(mockFinishCycle).toHaveBeenCalledWith('cycle_abc', expect.objectContaining({ cardIds: [] }));
  });
});

// ─── cycle_status — happy path + not-found ───────────────────────────────────

describe('cycle_status', () => {
  const cycleLoop = {
    loop: {
      loopId: 'cycle_abc',
      kind: 'cycle',
      principal: 'did:imajin:alice',
      parentLoopId: null,
      refs: {},
      state: 'report',
      summary: 'cycle in progress',
      lastEventType: 'loop.progress',
      startedAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-01T00:05:00.000Z',
      finishedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:05:00.000Z',
    },
    events: [
      {
        id: 'ev1',
        loopId: 'cycle_abc',
        type: 'loop.progress',
        issuer: 'did:imajin:node',
        principal: 'did:imajin:alice',
        payload: { phase: 'merge-sweep', phaseStatus: 'skipped' },
        occurredAt: '2026-09-01T00:01:00.000Z',
        createdAt: '2026-09-01T00:01:00.000Z',
      },
      {
        id: 'ev2',
        loopId: 'cycle_abc',
        type: 'loop.progress',
        issuer: 'did:imajin:node',
        principal: 'did:imajin:alice',
        payload: { state: 'child-linked', childKind: 'warp.run', childId: 'run_1' },
        occurredAt: '2026-09-01T00:02:00.000Z',
        createdAt: '2026-09-01T00:02:00.000Z',
      },
      {
        id: 'ev3',
        loopId: 'cycle_abc',
        type: 'loop.blocked',
        issuer: 'did:imajin:node',
        principal: 'did:imajin:alice',
        payload: { phase: 'report', phaseStatus: 'blocked' },
        occurredAt: '2026-09-01T00:03:00.000Z',
        createdAt: '2026-09-01T00:03:00.000Z',
      },
    ],
  };

  it('reads by correlation_id, scoped to the acting DID', async () => {
    mockGetLoopWithHistory.mockResolvedValueOnce(cycleLoop);

    const out = parseResult(await call('cycle_status', { correlation_id: 'cycle_abc' }, ctxFor('did:imajin:alice')));

    expect(mockGetLoopWithHistory).toHaveBeenCalledWith('cycle_abc', 'did:imajin:alice');
    expect(out.correlationId).toBe('cycle_abc');
    expect(out.phases).toEqual({ 'merge-sweep': 'skipped', report: 'blocked' });
    expect(out.children).toEqual([{ childKind: 'warp.run', childId: 'run_1' }]);
  });

  it('resolves the caller\u2019s most recently active cycle when correlation_id is omitted', async () => {
    mockListLoopsPage.mockResolvedValueOnce({ loops: [{ loopId: 'cycle_recent' }], hasNextPage: false, nextCursor: null });
    mockGetLoopWithHistory.mockResolvedValueOnce({ ...cycleLoop, loop: { ...cycleLoop.loop, loopId: 'cycle_recent' } });

    const out = parseResult(await call('cycle_status', {}, ctxFor('did:imajin:alice')));

    expect(mockListLoopsPage).toHaveBeenCalledWith({ principal: 'did:imajin:alice', kind: 'cycle', limit: 1 });
    expect(mockGetLoopWithHistory).toHaveBeenCalledWith('cycle_recent', 'did:imajin:alice');
    expect(out.correlationId).toBe('cycle_recent');
  });

  it('fails closed with not_found when the caller has no cycles yet', async () => {
    mockListLoopsPage.mockResolvedValueOnce({ loops: [], hasNextPage: false, nextCursor: null });

    await expect(call('cycle_status', {}, ctxFor('did:imajin:alice'))).rejects.toThrow(/not_found/);
    expect(mockGetLoopWithHistory).not.toHaveBeenCalled();
  });

  it('fails closed with not_found for an unknown correlation_id', async () => {
    mockGetLoopWithHistory.mockResolvedValueOnce(null);

    await expect(call('cycle_status', { correlation_id: 'cycle_missing' }, ctxFor('did:imajin:alice'))).rejects.toThrow(
      /not_found/,
    );
  });

  it('fails closed with not_found for a loopId that exists but is not a cycle', async () => {
    mockGetLoopWithHistory.mockResolvedValueOnce({ ...cycleLoop, loop: { ...cycleLoop.loop, kind: 'warp.run' } });

    await expect(call('cycle_status', { correlation_id: 'run_1' }, ctxFor('did:imajin:alice'))).rejects.toThrow(
      /not_found/,
    );
  });

  it('reports open DecisionCard ids raised against this correlationId, excluding decided ones and other cycles\u2019', async () => {
    mockGetLoopWithHistory.mockResolvedValueOnce(cycleLoop);
    mockListApprovalsForOperator.mockResolvedValueOnce([
      { proposalId: 'dcard_open', status: 'pending', detail: { correlationId: 'cycle_abc' } },
      { proposalId: 'dcard_decided', status: 'approved', detail: { correlationId: 'cycle_abc' } },
      { proposalId: 'dcard_other_cycle', status: 'pending', detail: { correlationId: 'cycle_other' } },
    ]);

    const out = parseResult(await call('cycle_status', { correlation_id: 'cycle_abc' }, ctxFor('did:imajin:alice')));

    expect(mockListApprovalsForOperator).toHaveBeenCalledWith('did:imajin:operator', { source: 'decision' });
    expect(out.openCardIds).toEqual(['dcard_open']);
  });

  it('returns no open cards when the node has no configured operator', async () => {
    mockGetLoopWithHistory.mockResolvedValueOnce(cycleLoop);
    mockGetOperatorDid.mockResolvedValueOnce(null);

    const out = parseResult(await call('cycle_status', { correlation_id: 'cycle_abc' }, ctxFor('did:imajin:alice')));

    expect(mockListApprovalsForOperator).not.toHaveBeenCalled();
    expect(out.openCardIds).toEqual([]);
  });

  it('checks the scope-manifest grant before querying', async () => {
    mockGetLoopWithHistory.mockResolvedValueOnce(cycleLoop);

    await call('cycle_status', { correlation_id: 'cycle_abc' }, ctxFor('did:imajin:alice'));

    expect(mockRequireMcpGrant).toHaveBeenCalledWith('did:imajin:alice', 'cycle:run', 'did:imajin:mcp-connector');
  });
});

// ─── The scope gate ──────────────────────────────────────────────────────────

describe('scope gate', () => {
  it('denies cycle_run to a token without cycle:run', async () => {
    const res = await callViaGate('cycle_run', ['media:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('cycle:run');
    expect(mockStartCycle).not.toHaveBeenCalled();
  });

  it('denies cycle_status to a token without cycle:run', async () => {
    const res = await callViaGate('cycle_status', []);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(mockGetLoopWithHistory).not.toHaveBeenCalled();
  });

  it('lets a cycle:run token reach both handlers', async () => {
    const runRes = await callViaGate('cycle_run', ['cycle:run']);
    expect(runRes.result.isError).toBe(false);

    mockListLoopsPage.mockResolvedValueOnce({ loops: [], hasNextPage: false, nextCursor: null });
    const statusRes = await callViaGate('cycle_status', ['cycle:run']);
    // Resolves to the mocked not_found (no cycles yet) path — proof the gate
    // passed the call through, not that a cycle happens to exist.
    expect(statusRes.result.isError).toBe(true);
    expect(statusRes.result.content[0].text).toContain('not_found');
  });
});
