import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake postgres.js tagged-template client: records each query's skeleton +
// interpolated values so we can assert what SQL the reactor issues, no DB
// needed (packages/bus/AGENTS.md pattern).
const { calls, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve([]);
  };
  return { calls, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => 'evt_fixed_id' };
});

import { loopProjectionReactor } from '../src/reactors/loop-projection';
import type { BusEvent } from '../src/types';

const PUBLISHER = 'did:imajin:warp-node';
const PRINCIPAL = 'did:imajin:ryan';

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    type: 'loop.started',
    issuer: PUBLISHER,
    subject: PRINCIPAL,
    scope: 'loop',
    correlationId: 'loop_abc123',
    payload: {
      loopId: 'loop_abc123',
      kind: 'warp.run',
      principal: PRINCIPAL,
      state: 'queued',
      summary: 'Kicked off loops rail implementation',
      at: '2026-09-22T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('loopProjectionReactor (#2295)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('is a no-op for non-loop event types', async () => {
    await loopProjectionReactor(makeEvent({ type: 'warp.run.completed' }), {});
    expect(calls).toHaveLength(0);
  });

  it('skips silently when the payload has no loopId', async () => {
    await loopProjectionReactor(makeEvent({ payload: { kind: 'warp.run' } }), {});
    expect(calls).toHaveLength(0);
  });

  it('skips silently when required envelope fields are missing', async () => {
    await loopProjectionReactor(
      makeEvent({ payload: { loopId: 'loop_abc123', kind: 'warp.run' } }),
      {},
    );
    expect(calls).toHaveLength(0);
  });

  it('writes an immutable event row then upserts the loops projection on loop.started', async () => {
    await loopProjectionReactor(makeEvent(), {});

    expect(calls).toHaveLength(2);

    expect(calls[0].text).toContain('INSERT INTO kernel.loop_events');
    expect(calls[0].values).toEqual([
      'evt_fixed_id',
      'loop_abc123',
      'loop.started',
      PUBLISHER,
      PRINCIPAL,
      JSON.stringify({
        loopId: 'loop_abc123',
        kind: 'warp.run',
        principal: PRINCIPAL,
        state: 'queued',
        summary: 'Kicked off loops rail implementation',
        at: '2026-09-22T00:00:00.000Z',
      }),
      '2026-09-22T00:00:00.000Z',
    ]);

    expect(calls[1].text).toContain('INSERT INTO kernel.loops');
    expect(calls[1].text).toContain('ON CONFLICT (loop_id) DO UPDATE');
    expect(calls[1].values).toEqual([
      'loop_abc123',
      'warp.run',
      PRINCIPAL,
      null, // parentLoopId
      '{}', // refs
      'queued',
      'Kicked off loops rail implementation',
      'loop.started',
      '2026-09-22T00:00:00.000Z',
      '2026-09-22T00:00:00.000Z',
      null, // finishedAt — only set on loop.finished
    ]);
  });

  it('carries parentLoopId and refs through when present', async () => {
    await loopProjectionReactor(
      makeEvent({
        type: 'loop.progress',
        payload: {
          loopId: 'loop_child',
          kind: 'openclaw.subagent',
          principal: PRINCIPAL,
          parentLoopId: 'loop_abc123',
          refs: { runId: 'run_1', sessionKey: 'sess_1' },
          state: 'running',
          summary: 'Sub-agent working',
          at: '2026-09-22T00:05:00.000Z',
        },
      }),
      {},
    );

    // positional check: values[0]=loop_id, [1]=kind, [2]=principal, [3]=parent_loop_id
    expect(calls[1].values[0]).toBe('loop_child');
    expect(calls[1].values[3]).toBe('loop_abc123');
    expect(JSON.parse(calls[1].values[4] as string)).toEqual({ runId: 'run_1', sessionKey: 'sess_1' });
  });

  it('sets finishedAt only for loop.finished', async () => {
    await loopProjectionReactor(
      makeEvent({
        type: 'loop.finished',
        payload: {
          loopId: 'loop_abc123',
          kind: 'warp.run',
          principal: PRINCIPAL,
          state: 'succeeded',
          summary: 'Done',
          at: '2026-09-22T01:00:00.000Z',
        },
      }),
      {},
    );

    // values: loop_id, kind, principal, parent_loop_id, refs, state, summary, last_event_type, started_at, last_seen_at, finished_at
    expect(calls[1].values[10]).toBe('2026-09-22T01:00:00.000Z');
  });

  it('guards the projection update against out-of-order delivery', async () => {
    await loopProjectionReactor(makeEvent(), {});
    expect(calls[1].text).toContain('WHERE kernel.loops.last_seen_at <= EXCLUDED.last_seen_at');
  });
});
