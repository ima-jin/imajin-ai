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
import { projectHorizon, type HorizonLease } from '../../loops/horizon';
import type { LoopEventJson } from '../../loops/serialize';
import {
  CODE_STEP, STEP_ISSUE_UPDATE, STEP_READY, STEP_NOW, stepEvent,
} from '../../loops/__tests__/horizon-fixtures';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

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
const mockGetLastStepEventAt = vi.hoisted(() => vi.fn());
vi.mock('../../loops/query', () => ({
  getLoopWithHistory: mockGetLoopWithHistory,
  listLoopsPage: mockListLoopsPage,
  getLastStepEventAt: mockGetLastStepEventAt,
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
  mockGetLastStepEventAt.mockResolvedValue(null);
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

// Real projectHorizon fixtures: tools summarize registry projections, not a second zone engine.
describe('caller horizon (#2882)', () => {
  const alice = 'did:imajin:alice';
  const bob = 'did:imajin:bob';
  let events: LoopEventJson[];
  let leases: HorizonLease[];

  function publish(principal: string, loopId: string, stepId: string, updates: Record<string, unknown> = {}) {
    const queued = stepEvent('step.queued', events.length, { step: structuredClone(CODE_STEP) }, stepId);
    const updated = stepEvent('step.updated', events.length + 1, { update: updates }, stepId);
    for (const event of [queued, updated]) {
      events.push({ ...event, loopId, principal, issuer: principal });
    }
  }

  function observe(stepId: string, conditionId: string, evidence: Record<string, unknown>) {
    const event = stepEvent('step.observed', events.length + 10, {
      observation: { conditionId, evidence },
    }, stepId);
    events.push({ ...event, loopId: 'horizon-alice', principal: alice, issuer: alice });
  }

  beforeEach(() => {
    events = [];
    leases = [];
    mockListLoopsPage.mockImplementation(async ({ principal, kind }) => ({
      loops: kind ? [] : [...new Set(events.filter(e => e.principal === principal).map(e => e.loopId))]
        .map(loopId => ({ loopId })),
      hasNextPage: false, nextCursor: null,
    }));
    mockGetLoopWithHistory.mockImplementation(async (loopId, principal) => {
      const owned = events.filter(e => e.loopId === loopId && e.principal === principal);
      if (owned.length === 0) return null;
      return {
        loop: { loopId, principal, kind: 'cycle' }, events: owned,
        horizon: projectHorizon(owned, loopId, principal, STEP_NOW, false, leases),
      };
    });
    mockGetLastStepEventAt.mockImplementation(async principal =>
      events.find(e => e.principal === principal)?.occurredAt ?? null);
  });

  it.each(['cycle_status', 'cycle_run'])('%s returns all five zone counts, excluding exited steps', async name => {
    for (const id of ['tail', 'middle', 'near', 'head', 'past', 'done']) {
      const update = id === 'tail' ? {} : { ...STEP_ISSUE_UPDATE, ...(id === 'near' ? STEP_READY : {}) };
      publish(alice, 'horizon-alice', id, update);
    }
    leases.push({
      surface: 'step:head', loopId: 'horizon-alice', principal: alice, holderDid: alice,
      acquiredAt: new Date(STEP_NOW - 1000).toISOString(), expiresAt: new Date(STEP_NOW + 1000).toISOString(),
    });
    for (const id of ['past', 'done']) {
      observe(id, 'closed', { kind: 'issue_closed', issue: STEP_ISSUE_UPDATE.issue.ref });
    }
    observe('done', 'released', {
      kind: 'release_contains', repository: CODE_STEP.repository, issue: STEP_ISSUE_UPDATE.issue.ref,
      mergeCommit: 'a'.repeat(40), tag: 'v1.0.0',
    });
    observe('done', 'prod', { kind: 'deployed', repository: CODE_STEP.repository, tag: 'v1.0.0', environment: 'prod' });

    const out = parseResult(await call(name, {}, ctxFor(alice)));
    expect(out.horizon).toEqual({
      depth: 5, targetDepth: 12, deficit: 7,
      zones: { tail: 1, middle: 1, near: 1, head: 1, past: 1 }, noStepsPublished: false,
    });
    expect(out.belowDepth).toEqual({ deficit: 7 });
  });

  it.each(['cycle_status', 'cycle_run'])('%s distinguishes never-published from a drained horizon', async name => {
    const out = parseResult(await call(name, {}, ctxFor(alice)));
    expect(out.horizon).toEqual({
      depth: 0, targetDepth: 12, deficit: 12,
      zones: { tail: 0, middle: 0, near: 0, head: 0, past: 0 },
      noStepsPublished: true, message: 'No horizon steps published yet',
    });
    expect(out.belowDepth).toEqual({ deficit: 12 });

    mockGetLastStepEventAt.mockResolvedValueOnce(new Date(STEP_NOW).toISOString());
    const drained = parseResult(await call(name, {}, ctxFor(alice)));
    expect(drained.horizon.noStepsPublished).toBe(false);
    expect(drained.horizon).not.toHaveProperty('message');
    expect(drained.horizon.depth).toBe(0);
  });

  it.each([12, 13])('omits belowDepth at depth %i and never returns a negative deficit', async depth => {
    for (let i = 0; i < depth; i++) publish(alice, 'horizon-alice', `step-${i}`);
    for (const name of ['cycle_status', 'cycle_run']) {
      const out = parseResult(await call(name, {}, ctxFor(alice)));
      expect(out.horizon.depth).toBe(depth);
      expect(out.horizon.deficit).toBe(0);
      expect(out).not.toHaveProperty('belowDepth');
    }
  });

  it('captures cycle_run before startCycle and never refreshes after phases change the horizon', async () => {
    publish(alice, 'horizon-alice', 'first', { ...STEP_ISSUE_UPDATE, ...STEP_READY });
    mockStartCycle.mockImplementationOnce(async () => {
      publish(alice, 'horizon-alice', 'second');
      return { ok: true, correlationId: 'cycle_abc' };
    });
    const out = parseResult(await call('cycle_run', {}, ctxFor(alice)));
    expect(out.horizon.depth).toBe(1);
    expect(out.horizon.zones.near).toBe(1);
    expect(mockGetLastStepEventAt).toHaveBeenCalledTimes(1);
    expect(mockGetLastStepEventAt.mock.invocationCallOrder[0])
      .toBeLessThan(mockStartCycle.mock.invocationCallOrder[0]);
    expect(mockStartCycle.mock.invocationCallOrder[0]).toBeLessThan(mockCyclePhase.mock.invocationCallOrder[0]);
    const status = parseResult(await call('cycle_status', {}, ctxFor(alice)));
    expect(status.horizon.depth).toBe(2);
  });

  it.each(['cycle_status', 'cycle_run'])('%s never returns another principal’s horizon, even with spoofed arguments', async name => {
    publish(alice, 'horizon-alice', 'alice-step');
    publish(bob, 'horizon-bob', 'bob-step', STEP_ISSUE_UPDATE);
    const a = parseResult(await call(name, { principal: bob, loop_id: 'horizon-bob' }, ctxFor(alice)));
    const b = parseResult(await call(name, {}, ctxFor(bob)));
    expect(a.horizon.zones).toEqual({ tail: 1, middle: 0, near: 0, head: 0, past: 0 });
    expect(b.horizon.zones).toEqual({ tail: 0, middle: 1, near: 0, head: 0, past: 0 });
    expect(mockGetLoopWithHistory).not.toHaveBeenCalledWith('horizon-bob', alice);
    expect(mockGetLastStepEventAt).toHaveBeenCalledWith(alice);
    expect(mockGetLastStepEventAt).toHaveBeenCalledWith(bob);
    await expect(call('cycle_status', { correlation_id: 'horizon-bob' }, ctxFor(alice))).rejects.toThrow(/not_found/);
  });

  it('continues through registry pages including non-cycle loops, without applying repo scope', async () => {
    publish(alice, 'older-loop', 'older');
    publish(alice, 'newer-loop', 'newer');
    mockListLoopsPage.mockResolvedValueOnce({
      loops: [{ loopId: 'newer-loop' }, { loopId: 'unavailable' }], nextCursor: 'older', hasNextPage: true,
    }).mockResolvedValueOnce({ loops: [{ loopId: 'older-loop' }], nextCursor: null, hasNextPage: false });
    const out = parseResult(await call('cycle_run', { scope: { repo: 'another/repo' } }, ctxFor(alice)));
    expect(out.horizon.depth).toBe(2);
    expect(mockListLoopsPage).toHaveBeenNthCalledWith(1, { principal: alice, limit: 200, cursor: null });
    expect(mockListLoopsPage).toHaveBeenNthCalledWith(2, { principal: alice, limit: 200, cursor: 'older' });
  });

  it.each(['cycle_status', 'cycle_run'])('%s fails closed before reading the horizon when the live grant is revoked', async name => {
    mockRequireMcpGrant.mockRejectedValueOnce(new Error('grant revoked'));
    await expect(call(name, {}, ctxFor(alice))).rejects.toThrow('grant revoked');
    expect(mockListLoopsPage).not.toHaveBeenCalled();
    expect(mockGetLastStepEventAt).not.toHaveBeenCalled();
    expect(mockGetLoopWithHistory).not.toHaveBeenCalled();
  });

  it('does not turn a registry outage into an empty horizon or start a cycle', async () => {
    mockListLoopsPage.mockRejectedValueOnce(new Error('registry unavailable'));
    await expect(call('cycle_run', {}, ctxFor(alice))).rejects.toThrow('registry unavailable');
    expect(mockStartCycle).not.toHaveBeenCalled();
  });

  it('advertises the horizon contract in tools/list and the served /spec document', async () => {
    const listed = await handleMcpRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxFor(alice)) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const spec = parse(readFileSync(resolve('apps/kernel/api-spec/jin.yaml'), 'utf8'));
    for (const name of ['cycle_status', 'cycle_run']) {
      const description = listed.result.tools.find(t => t.name === name)?.description;
      for (const field of ['depth', 'targetDepth', 'deficit', 'zones', 'belowDepth', 'noStepsPublished']) {
        expect(description).toContain(field);
      }
      expect(spec['x-mcp-tools'][name].responseSchema).toEqual({ $ref: '#/components/schemas/CycleHorizonReadout' });
    }
    expect(spec.components.schemas.CycleHorizonSummary.required)
      .toEqual(['depth', 'targetDepth', 'deficit', 'zones', 'noStepsPublished']);
    expect(Object.keys(spec.components.schemas.CycleHorizonSummary.properties.zones.properties))
      .toEqual(['tail', 'middle', 'near', 'head', 'past']);
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
    expect(out).toMatchObject({ correlationId: 'cycle_abc', horizon: { depth: 0, targetDepth: 12 } });
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

  it('returns an empty horizon without an error when the caller has no cycles yet', async () => {
    mockListLoopsPage.mockResolvedValueOnce({ loops: [], hasNextPage: false, nextCursor: null });

    const out = parseResult(await call('cycle_status', {}, ctxFor('did:imajin:alice')));
    expect(out).toMatchObject({ correlationId: null, state: 'not_started', horizon: { depth: 0 } });
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
    expect(statusRes.result.isError).toBe(false);
    expect(parseResult(statusRes.result.content).horizon.depth).toBe(0);
  });
});
