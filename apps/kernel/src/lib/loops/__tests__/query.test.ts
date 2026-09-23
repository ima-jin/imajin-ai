import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake postgres.js tagged-template client. `resolveWith` queues the next
// call's return value; `calls` records each query's skeleton + interpolated
// values, mirroring packages/bus's fakeSql test pattern.
const { calls, fakeSql, resolveWith } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const queue: unknown[][] = [];
  const resolveWith = (rows: unknown[]) => { queue.push(rows); };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  return { calls, fakeSql, resolveWith };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { listLoops, getLoopWithHistory } from '../query';

const PRINCIPAL = 'did:imajin:ryan';

function rawLoopRow(overrides: Record<string, unknown> = {}) {
  return {
    loop_id: 'loop_1',
    kind: 'warp.run',
    principal: PRINCIPAL,
    parent_loop_id: null,
    refs: {},
    state: 'running',
    summary: 'in progress',
    last_event_type: 'loop.progress',
    started_at: '2026-09-22T00:00:00.000Z',
    last_seen_at: '2026-09-22T00:05:00.000Z',
    finished_at: null,
    created_at: '2026-09-22T00:00:00.000Z',
    updated_at: '2026-09-22T00:05:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
});

describe('listLoops', () => {
  it('scopes the plain list query to principal and passes filters through as nullable params', async () => {
    resolveWith([rawLoopRow()]);

    const result = await listLoops({ principal: PRINCIPAL, state: 'running', kind: null, since: null });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('SELECT * FROM kernel.loops');
    expect(calls[0].text).toContain('WHERE principal');
    expect(calls[0].values).toEqual([PRINCIPAL, 'running', 'running', null, null, null, null, 50]);
    expect(result).toHaveLength(1);
    expect(result[0].loopId).toBe('loop_1');
    expect(result[0].startedAt).toBe(new Date('2026-09-22T00:00:00.000Z').toISOString());
  });

  it('clamps limit to the max and falls back to the default for invalid values', async () => {
    resolveWith([]);
    await listLoops({ principal: PRINCIPAL, limit: 10_000 });
    expect(calls[0].values[calls[0].values.length - 1]).toBe(200);

    resolveWith([]);
    await listLoops({ principal: PRINCIPAL, limit: -5 });
    expect(calls[1].values[calls[1].values.length - 1]).toBe(50);
  });

  it('recursively walks the descendant lineage tree to depth >= 3 when ancestor is set', async () => {
    // Root (depth 0) -> child (depth 1) -> grandchild (depth 2) -> great-grandchild (depth 3).
    const root = rawLoopRow({ loop_id: 'loop_root', parent_loop_id: null, summary: 'root' });
    const child = rawLoopRow({ loop_id: 'loop_child', parent_loop_id: 'loop_root', summary: 'child' });
    const grandchild = rawLoopRow({ loop_id: 'loop_grandchild', parent_loop_id: 'loop_child', summary: 'grandchild' });
    const greatGrandchild = rawLoopRow({ loop_id: 'loop_ggc', parent_loop_id: 'loop_grandchild', summary: 'great-grandchild' });

    // The recursive CTE is a single SQL statement — the fake client returns
    // whatever a real recursive-CTE query would compute in one round trip.
    resolveWith([root, child, grandchild, greatGrandchild]);

    const result = await listLoops({ principal: PRINCIPAL, ancestor: 'loop_root' });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('WITH RECURSIVE lineage AS');
    expect(calls[0].text).toContain('JOIN lineage ON l.parent_loop_id = lineage.loop_id');
    expect(calls[0].values).toEqual(['loop_root', PRINCIPAL, PRINCIPAL, null, null, null, null]);

    expect(result.map((l) => l.loopId)).toEqual(['loop_root', 'loop_child', 'loop_grandchild', 'loop_ggc']);
    expect(result.map((l) => l.parentLoopId)).toEqual([null, 'loop_root', 'loop_child', 'loop_grandchild']);
  });

  it('applies state/kind filters on top of the ancestor lineage query', async () => {
    resolveWith([]);
    await listLoops({ principal: PRINCIPAL, ancestor: 'loop_root', state: 'blocked', kind: 'review' });

    expect(calls[0].values).toEqual(['loop_root', PRINCIPAL, PRINCIPAL, 'blocked', 'blocked', 'review', 'review']);
  });
});

describe('getLoopWithHistory', () => {
  it('returns null when the loop does not exist for this principal (never reveals existence otherwise)', async () => {
    resolveWith([]); // loop lookup returns nothing

    const result = await getLoopWithHistory('loop_1', PRINCIPAL);

    expect(result).toBeNull();
    expect(calls).toHaveLength(1); // never queries event history for a miss
  });

  it('returns the loop plus its ordered event history on a hit', async () => {
    resolveWith([rawLoopRow()]);
    resolveWith([
      { id: 'evt_1', loop_id: 'loop_1', type: 'loop.started', issuer: 'did:imajin:warp-node', principal: PRINCIPAL, payload: {}, occurred_at: '2026-09-22T00:00:00.000Z', created_at: '2026-09-22T00:00:00.000Z' },
      { id: 'evt_2', loop_id: 'loop_1', type: 'loop.progress', issuer: 'did:imajin:warp-node', principal: PRINCIPAL, payload: {}, occurred_at: '2026-09-22T00:05:00.000Z', created_at: '2026-09-22T00:05:00.000Z' },
    ]);

    const result = await getLoopWithHistory('loop_1', PRINCIPAL);

    expect(result).not.toBeNull();
    expect(result?.loop.loopId).toBe('loop_1');
    expect(result?.events.map((e) => e.type)).toEqual(['loop.started', 'loop.progress']);
    expect(calls[0].values).toEqual(['loop_1', PRINCIPAL]);
    expect(calls[1].text).toContain('FROM kernel.loop_events');
    expect(calls[1].values).toEqual(['loop_1']);
  });
});
