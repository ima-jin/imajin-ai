import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake postgres.js tagged-template client: records each query's skeleton +
// interpolated values so we can assert what SQL the reactor issues, no DB
// needed (packages/bus/AGENTS.md pattern).
const { calls, fakeSql, store, resetStore } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const store = {
    loops: new Map<string, unknown[]>(),
    events: [] as unknown[][],
    failHistory: false,
    commits: 0,
    rollbacks: 0,
    begins: 0,
    beforeCommit: Promise.resolve(),
  };
  let pending = Promise.resolve();
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ');
    calls.push({ text, values });
    if (text.includes('INSERT INTO kernel.loops')) {
      const existing = store.loops.get(values[0] as string);
      if (!existing || (existing[2] === values[2] && String(existing[9]) <= String(values[9]))) {
        store.loops.set(values[0] as string, values);
      }
    } else if (text.includes('SELECT principal')) {
      const row = store.loops.get(values[0] as string);
      return Promise.resolve(row ? [{ principal: row[2] }] : []);
    } else if (text.includes('INSERT INTO kernel.loop_events')) {
      if (store.failHistory) return Promise.reject(new Error('history unavailable'));
      store.events.push(values);
    }
    return Promise.resolve([]);
  };
  // Model transaction serialization and rollback, not just recorded SQL.
  // Separate SQL assertions below ensure the real upsert has the same guard.
  const begin = async (work: (tx: typeof fakeSql) => Promise<void>) => {
    store.begins++;
    const previous = pending;
    let release = () => {};
    pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const loops = new Map(store.loops);
    const events = [...store.events];
    try {
      await work(fakeSql);
      await store.beforeCommit;
      store.commits++;
    } catch (error) {
      store.loops = loops;
      store.events = events;
      store.rollbacks++;
      throw error;
    } finally {
      release();
    }
  };
  const resetStore = () => {
    store.loops.clear();
    store.events = [];
    store.failHistory = false;
    store.commits = 0;
    store.rollbacks = 0;
    store.begins = 0;
    store.beforeCommit = Promise.resolve();
    pending = Promise.resolve();
  };
  return { calls, fakeSql: Object.assign(fakeSql, { begin }), store, resetStore };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => 'evt_fixed_id' };
});

import { loopProjectionReactor, LoopOwnershipConflictError } from '../src/reactors/loop-projection';
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

function transition(principal: string, at: string, type: BusEvent['type'] = 'loop.progress'): BusEvent {
  const event = makeEvent();
  return makeEvent({ type, payload: { ...event.payload, principal, at, summary: 'Updated' } });
}

describe('loopProjectionReactor (#2295)', () => {
  beforeEach(() => {
    calls.length = 0;
    resetStore();
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

  it('atomically upserts the owned projection then writes an immutable event on loop.started', async () => {
    await loopProjectionReactor(makeEvent(), {});

    expect(calls).toHaveLength(3);
    expect(store.commits).toBe(1);
    expect(calls[1].text).toContain('SELECT principal');
    expect(calls[1].text).toContain('FOR UPDATE');

    expect(calls[2].text).toContain('INSERT INTO kernel.loop_events');
    expect(calls[2].values).toEqual([
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

    expect(calls[0].text).toContain('INSERT INTO kernel.loops');
    expect(calls[0].text).toContain('ON CONFLICT (loop_id) DO UPDATE');
    expect(calls[0].values).toEqual([
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
      false, // initialObservation — normal transitions may advance existing loops
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
    expect(calls[0].values[0]).toBe('loop_child');
    expect(calls[0].values[3]).toBe('loop_abc123');
    expect(JSON.parse(calls[0].values[4] as string)).toEqual({ runId: 'run_1', sessionKey: 'sess_1' });
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
    expect(calls[0].values[10]).toBe('2026-09-22T01:00:00.000Z');
  });

  it('guards the projection update against out-of-order delivery', async () => {
    await loopProjectionReactor(makeEvent(), {});
    expect(calls[0].text).toContain('WHERE kernel.loops.principal = EXCLUDED.principal');
    expect(calls[0].text).toContain('AND kernel.loops.last_seen_at <= EXCLUDED.last_seen_at');
    expect(calls[0].text).not.toContain('principal = EXCLUDED.principal,');
  });

  it('merges new refs over persisted refs instead of erasing sparse-event linkage', async () => {
    await loopProjectionReactor(makeEvent(), {});
    expect(calls[0].text).toContain('refs = kernel.loops.refs || EXCLUDED.refs');
    expect(calls[0].values[4]).toBe('{}');
  });

  it.each(['loop.started', 'loop.progress', 'loop.blocked', 'loop.finished'] as const)(
    'rejects principal takeover through %s without writing history or changing projection',
    async (type) => {
      await loopProjectionReactor(makeEvent(), {});
      const before = store.loops.get('loop_abc123');
      await expect(loopProjectionReactor(
        transition('did:imajin:other', '2026-09-23T00:00:00.000Z', type), {},
      )).rejects.toMatchObject({ name: 'LoopOwnershipConflictError', code: 'loop_owner_conflict' });
      expect(store.loops.get('loop_abc123')).toEqual(before);
      expect(store.events).toHaveLength(1);
      expect(store.rollbacks).toBe(1);
    },
  );

  it('serializes concurrent first writes so exactly one principal owns all history', async () => {
    let release = () => {};
    store.beforeCommit = new Promise<void>((resolve) => { release = resolve; });
    const first = loopProjectionReactor(makeEvent(), {});
    await vi.waitFor(() => expect(store.begins).toBe(1));
    const second = loopProjectionReactor(transition('did:imajin:other', '2026-09-23T00:00:00.000Z'), {});
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(store.begins).toBe(2));
    release();
    const outcomes = await settled;
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(LoopOwnershipConflictError);
    expect(store.events).toHaveLength(1);
    expect(store.events[0][4]).toBe(store.loops.get('loop_abc123')?.[2]);
  });

  it('logs older same-principal events without regressing the current projection', async () => {
    await loopProjectionReactor(transition(PRINCIPAL, '2026-09-23T00:00:00.000Z'), {});
    await loopProjectionReactor(makeEvent(), {});
    expect(store.events).toHaveLength(2);
    expect(store.loops.get('loop_abc123')?.[9]).toBe('2026-09-23T00:00:00.000Z');
    expect(store.commits).toBe(2);
  });

  it('rolls back a first projection when history persistence fails and propagates failure', async () => {
    store.failHistory = true;
    await expect(loopProjectionReactor(makeEvent(), {})).rejects.toThrow('history unavailable');
    expect(store.loops.size).toBe(0);
    expect(store.events).toHaveLength(0);
    expect(store.rollbacks).toBe(1);
  });

  it('rolls back projection changes when appending subsequent history fails', async () => {
    await loopProjectionReactor(makeEvent(), {});
    const before = store.loops.get('loop_abc123');
    store.failHistory = true;
    await expect(loopProjectionReactor(
      transition(PRINCIPAL, '2026-09-23T00:00:00.000Z'), {},
    )).rejects.toThrow('history unavailable');
    expect(store.loops.get('loop_abc123')).toEqual(before);
    expect(store.events).toHaveLength(1);
  });

  it('retains typed output as opaque nested payload data', async () => {
    const event = makeEvent();
    const output = { kind: 'tool_result', result: { nested: ['opaque', { value: 1 }] } };
    await loopProjectionReactor(makeEvent({ payload: { ...event.payload, output } }), {});
    expect(JSON.parse(store.events[0][5] as string).output).toEqual(output);
    expect(event.payload).not.toHaveProperty('output');
  });

  it('uses the event timestamp when at is absent', async () => {
    const event = makeEvent();
    delete event.payload.at;
    event.timestamp = '2026-09-23T00:00:00.000Z';
    await loopProjectionReactor(event, {});
    expect(store.events[0][6]).toBe(event.timestamp);
  });
});
