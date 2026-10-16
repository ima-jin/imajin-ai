import { describe, expect, it } from 'vitest';
import { isBlockedLoop, mergeRuns, orderRuns } from '../runs-lane';
import { runLoop } from './runs-fixture';

describe('Runs lane ordering', () => {
  it('recognizes arbitrary blocked states from lifecycle and never flags finished loops', () => {
    expect(isBlockedLoop(runLoop({ lastEventType: 'loop.blocked', state: 'awaiting_review' }))).toBe(true);
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
});
