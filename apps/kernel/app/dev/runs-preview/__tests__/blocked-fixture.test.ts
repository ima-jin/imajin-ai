import { describe, expect, it } from 'vitest';
import { blockedFixtureLoops } from '../blocked-fixture';
import { isBlockedLoop, visibleRuns } from '@/src/lib/jin/runs-lane';

describe('Blocked-on-you before/after fixture', () => {
  it('retains all threads while removing merged/closed/review/superseded items from the held lane', () => {
    const before = blockedFixtureLoops('did:imajin:fixture', 'before');
    const after = blockedFixtureLoops('did:imajin:fixture', 'after');
    expect(before.filter(isBlockedLoop)).toHaveLength(6);
    expect(after.filter(isBlockedLoop).map(loop => loop.loopId)).toEqual(['fixture-draft', 'fixture-no-pr']);
    expect(after.some(loop => loop.summary === 'cost updated')).toBe(false);
    expect(visibleRuns(after)).toHaveLength(6);
  });
});
