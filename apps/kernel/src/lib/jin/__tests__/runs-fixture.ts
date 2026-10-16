import type { LoopJson } from '@/src/lib/loops/serialize';

export function runLoop(overrides: Partial<LoopJson> = {}): LoopJson {
  return {
    loopId: 'loop-1',
    kind: 'warp.run',
    principal: 'did:imajin:operator',
    parentLoopId: null,
    refs: { runId: 'run-1', issue: 'ima-jin/imajin-ai#2290' },
    state: 'running',
    summary: 'Implement registry',
    lastEventType: 'loop.progress',
    startedAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-02T00:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}
