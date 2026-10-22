import type { LoopJson } from '@/src/lib/loops/serialize';

/** Illustrative provider observations; no production auth or transport is bypassed. */
export function blockedFixtureLoops(principal: string, phase: string): LoopJson[] {
  const at = new Date().toISOString();
  const cases = [
    { id: 'merged', before: 'PR #2993 remains draft because screenshots are missing', after: 'resolved · PR #2993 merged', state: 'resolved' },
    { id: 'closed', before: 'PR #2975 remains draft because live replay is blocked', after: 'resolved · PR #2975 closed', state: 'resolved' },
    { id: 'ready', before: 'Waiting for review of PR #2980', after: 'awaiting review · PR #2980', state: 'awaiting_review' },
    { id: 'draft', before: 'Waiting on Postal decision · PR #2973', after: 'Waiting on Postal decision · PR #2973', state: 'blocked' },
    { id: 'no-pr', before: 'cost updated', after: 'Waiting for operator repository access', state: 'blocked' },
    { id: 'child', before: 'Waiting for parent instructions', after: 'superseded · parent run succeeded', state: 'superseded' },
  ];
  return cases.map(item => {
    const state = phase === 'before' ? 'blocked' : item.state;
    const terminal = ['resolved', 'superseded'].includes(state);
    return { loopId: `fixture-${item.id}`, kind: 'warp.run', principal,
      parentLoopId: item.id === 'child' ? 'fixture-merged' : null, refs: {},
      state, summary: phase === 'before' ? item.before : item.after,
      lastEventType: terminal ? 'loop.finished' : 'loop.progress',
      startedAt: at, lastSeenAt: at, finishedAt: terminal ? at : null, createdAt: at, updatedAt: at };
  });
}
