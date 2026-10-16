import type { LoopJson } from '@/src/lib/loops/serialize';

export function isBlockedLoop(loop: LoopJson): boolean {
  return !loop.finishedAt && (loop.lastEventType === 'loop.blocked' || loop.state.toLowerCase() === 'blocked');
}

/** Blockers precede other rows, newest first within each group; never mutate registry pages. */
export function orderRuns(loops: LoopJson[]): LoopJson[] {
  return [...loops].sort((a, b) =>
    Number(isBlockedLoop(b)) - Number(isBlockedLoop(a))
    || b.lastSeenAt.localeCompare(a.lastSeenAt)
    || b.loopId.localeCompare(a.loopId));
}

export function mergeRuns(previous: LoopJson[], incoming: LoopJson[]): LoopJson[] {
  return orderRuns([...new Map([...previous, ...incoming].map((loop) => [loop.loopId, loop])).values()]);
}
