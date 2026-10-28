import { describe, expect, it } from 'vitest';
import { conflictsForLoop, isBlockedLoop, mergeRuns, orderRuns, runTree, visibleRuns } from '../runs-lane';
import type { LoopEventJson } from '@/src/lib/loops/serialize';
import { runLoop } from './runs-fixture';

describe('Runs lane ordering', () => {
  it('hides archived roots and descendants from active rows without mutating retained history', () => {
    const loops = [
      runLoop({ loopId: 'root', kind: 'openclaw.session' }),
      runLoop({ loopId: 'archived-child', parentLoopId: 'root', kind: 'custom', state: 'archived' }),
      runLoop({ loopId: 'archived', state: 'archived', finishedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }),
    ];
    expect(visibleRuns(loops).map(loop => loop.loopId)).toEqual(['root']);
    expect(loops).toHaveLength(3);
    expect(loops[2].state).toBe('archived');
  });
  it('recognizes arbitrary blocked states from lifecycle and never flags finished loops', () => {
    expect(isBlockedLoop(runLoop({ lastEventType: 'loop.blocked', state: 'awaiting_review' }))).toBe(false);
    expect(isBlockedLoop(runLoop({ kind: 'custom', lastEventType: 'loop.blocked', state: 'awaiting_review' }))).toBe(true);
    for (const state of ['resolved', 'superseded']) {
      expect(isBlockedLoop(runLoop({ lastEventType: 'loop.blocked', state }))).toBe(false);
    }
    expect(isBlockedLoop(runLoop({ state: 'BLOCKED' }))).toBe(true);
    expect(isBlockedLoop(runLoop())).toBe(false);
    expect(isBlockedLoop(runLoop({ state: 'blocked', finishedAt: '2026-10-03T00:00:00Z' }))).toBe(false);
  });

  it('puts blockers first then newest timestamp and deterministic ID without mutation', () => {
    const loops = [
      runLoop({ loopId: 'a' }),
      runLoop({ loopId: 'b' }),
      runLoop({ loopId: 'old', lastEventType: 'loop.blocked', lastSeenAt: '2026-09-01T00:00:00Z' }),
      runLoop({ loopId: 'new', lastSeenAt: '2026-10-03T00:00:00Z' }),
    ];
    expect(orderRuns(loops).map((loop) => loop.loopId)).toEqual(['old', 'new', 'b', 'a']);
    expect(loops[0].loopId).toBe('a');
  });

  it('merges pages by ID, replacing stale state without duplicate cards', () => {
    const previous = [runLoop(), runLoop({ loopId: 'other' })];
    const update = runLoop({ state: 'blocked', summary: 'Needs review' });
    expect(mergeRuns(previous, [update])).toEqual([update, previous[1]]);
  });

  it('limits roots to active/recent session or Warp threads and preserves descendant context', () => {
    const loops = [
      runLoop({ loopId: 'active', kind: 'openclaw.session' }),
      runLoop({ loopId: 'child', kind: 'custom.context', parentLoopId: 'active' }),
      runLoop({ loopId: 'grandchild', kind: 'custom.context', parentLoopId: 'child' }),
      runLoop({ loopId: 'orphan', kind: 'openclaw.subagent', parentLoopId: 'unloaded' }),
      runLoop({ loopId: 'recent', finishedAt: '2026-10-02T00:00:00Z' }),
      runLoop({ loopId: 'old', finishedAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-09-01T00:00:00Z' }),
      runLoop({ loopId: 'other', kind: 'review' }),
    ];
    expect(visibleRuns(loops, Date.parse('2026-10-03T00:00:00Z')).map((loop) => loop.loopId))
      .toEqual(['active', 'child', 'grandchild', 'orphan', 'recent']);
  });

  it('keeps descendants, missing parents and cycles visible exactly once', () => {
    const root = runLoop({ loopId: 'root' });
    const child = runLoop({ loopId: 'child', parentLoopId: 'root', kind: 'openclaw.subagent' });
    const orphan = runLoop({ loopId: 'orphan', parentLoopId: 'unloaded' });
    const a = runLoop({ loopId: 'a', parentLoopId: 'b' });
    const b = runLoop({ loopId: 'b', parentLoopId: 'a' });
    const rows = runTree([child, b, orphan, root, a]);
    expect(rows.map((row) => row.loop.loopId)).toEqual(['root', 'child', 'orphan', 'b', 'a']);
    expect(rows[1].depth).toBe(1);
    expect(rows[2].orphan).toBe(true);
    expect(new Set(rows.map((row) => row.loop.loopId)).size).toBe(5);
    expect(runTree([runLoop({ parentLoopId: 'loop-1' })])).toHaveLength(1);
  });

  it('projects conflicts onto both loop IDs and ignores unrelated/malformed events', () => {
    const event = { id: 'conflict', type: 'surface.conflicted', loopId: 'a', payload: {
      loopId: 'a', surface: 'issue:#2404', refs: { conflictingLoopId: 'b' },
    } } as unknown as LoopEventJson;
    expect(conflictsForLoop('a', [event])[0].otherLoopId).toBe('b');
    expect(conflictsForLoop('b', [event])[0].otherLoopId).toBe('a');
    expect(conflictsForLoop('c', [event])).toEqual([]);
    expect(conflictsForLoop('a', [{ ...event, type: 'loop.progress' }])).toEqual([]);
    expect(conflictsForLoop('a', [{ ...event, payload: {} }])).toEqual([]);
    const fallback = { ...event, payload: { refs: { conflictingLoopId: 'b' } } };
    expect(conflictsForLoop('a', [fallback])[0].surface).toBe('Shared surface');
  });
});
