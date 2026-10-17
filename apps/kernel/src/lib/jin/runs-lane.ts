import type { LoopJson } from '@/src/lib/loops/serialize';
import type { LoopEventJson } from '@/src/lib/loops/serialize';

export function isBlockedLoop(loop: LoopJson): boolean {
  return !loop.finishedAt && (loop.lastEventType === 'loop.blocked' || loop.state.toLowerCase() === 'blocked');
}

/** Active/recent session and Warp threads plus their loaded descendant context. */
export function visibleRuns(loops: LoopJson[], now = Date.now()): LoopJson[] {
  const recent = now - 7 * 24 * 60 * 60 * 1000;
  const ids = new Set(loops.filter((loop) =>
    ['openclaw.session', 'openclaw.subagent', 'warp.run'].includes(loop.kind)
    && (!loop.finishedAt || Date.parse(loop.lastSeenAt) >= recent)).map((loop) => loop.loopId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const loop of loops) {
      if (ids.has(loop.loopId) || !loop.parentLoopId || !ids.has(loop.parentLoopId)) continue;
      ids.add(loop.loopId);
      changed = true;
    }
  }
  return loops.filter((loop) => ids.has(loop.loopId));
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

export interface RunTreeRow {
  loop: LoopJson;
  depth: number;
  orphan: boolean;
}

/** Flatten once with a visited set: malformed cycles and paged-out parents stay visible. */
export function runTree(loops: LoopJson[]): RunTreeRow[] {
  const ordered = orderRuns(loops);
  const ids = new Set(ordered.map((loop) => loop.loopId));
  const children = new Map<string, LoopJson[]>();
  for (const loop of ordered) {
    if (loop.parentLoopId) children.set(loop.parentLoopId, [...(children.get(loop.parentLoopId) ?? []), loop]);
  }
  const visited = new Set<string>();
  const rows: RunTreeRow[] = [];
  const visit = (loop: LoopJson, depth: number) => {
    if (visited.has(loop.loopId)) return;
    visited.add(loop.loopId);
    rows.push({ loop, depth, orphan: !!loop.parentLoopId && !ids.has(loop.parentLoopId) });
    for (const child of children.get(loop.loopId) ?? []) visit(child, depth + 1);
  };
  for (const loop of ordered.filter((item) => !item.parentLoopId || !ids.has(item.parentLoopId))) visit(loop, 0);
  for (const loop of ordered) visit(loop, 0);
  return rows;
}

export interface RunConflict {
  id: string;
  loopId: string;
  otherLoopId: string;
  surface: string;
}

/** Only registry loop identifiers are inspected; warnings never become stop actions. */
export function conflictsForLoop(loopId: string, events: LoopEventJson[]): RunConflict[] {
  return events.flatMap((event) => {
    const refs = event.payload.refs as { conflictingLoopId?: unknown } | undefined;
    const first = typeof event.payload.loopId === 'string' ? event.payload.loopId : event.loopId;
    const second = refs?.conflictingLoopId;
    if (event.type !== 'surface.conflicted' || typeof second !== 'string') return [];
    if (first !== loopId && second !== loopId) return [];
    return [{
      id: event.id,
      loopId,
      otherLoopId: first === loopId ? second : first,
      surface: typeof event.payload.surface === 'string' ? event.payload.surface : 'Shared surface',
    }];
  });
}
