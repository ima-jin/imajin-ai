import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent, BusEventMap, LoopEventPayload } from '../src/types';

const { calls, store, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const store = {
    owner: 'did:imajin:owner' as string | undefined,
    events: new Map<unknown, unknown[]>(),
    failHistory: false,
    committed: false,
  };
  const fakeSql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(' ? ');
      calls.push({ text, values });
      if (text.includes('SELECT principal')) {
        return Promise.resolve(store.owner ? [{ principal: store.owner }] : []);
      }
      if (text.includes('INSERT INTO kernel.loop_events')) {
        if (store.failHistory) return Promise.reject(new Error('history unavailable'));
        if (!store.events.has(values[0])) store.events.set(values[0], values);
      }
      return Promise.resolve([]);
    },
    {
      begin: async (work: (tx: typeof fakeSql) => Promise<void>) => {
        await work(fakeSql);
        store.committed = true;
      },
    },
  );
  return { calls, store, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { loopProjectionReactor, LoopOwnershipConflictError } from '../src/reactors/loop-projection';

const STEP_TYPES = [
  'step.queued', 'step.updated', 'step.claimed', 'step.started', 'step.progress',
  'step.blocked', 'step.finished', 'step.observed', 'step.attested',
] as const satisfies ReadonlyArray<keyof BusEventMap>;

function stepEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  const payload: LoopEventPayload = {
    loopId: 'loop_1',
    stepId: 'step_1',
    kind: 'review',
    principal: 'did:imajin:owner',
    state: 'queued',
    summary: 'Review next change',
    at: '2026-10-17T00:00:00.000Z',
    output: { kind: 'text', text: 'Opaque observation' },
  };
  return {
    type: 'step.queued',
    id: 'signed:step-observation',
    issuer: 'did:imajin:publisher',
    subject: payload.principal,
    scope: 'loop',
    timestamp: '2026-10-18T00:00:00.000Z',
    payload,
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  store.owner = 'did:imajin:owner';
  store.events.clear();
  store.failHistory = false;
  store.committed = false;
});

describe('step observations (#2878)', () => {
  it.each(STEP_TYPES)('locks ownership then appends only immutable history for %s', async (type) => {
    const event = stepEvent({ type });
    await loopProjectionReactor(event, {});

    expect(calls).toHaveLength(2);
    expect(calls[0].text).toContain('SELECT principal FROM kernel.loops');
    expect(calls[0].text).toContain('FOR UPDATE');
    expect(calls[0].values).toEqual(['loop_1']);
    expect(calls[1].text).toContain('INSERT INTO kernel.loop_events');
    expect(calls[1].text).toContain('ON CONFLICT (id) DO NOTHING');
    expect(calls[1].values).toEqual([
      event.id, 'loop_1', type, event.issuer, event.payload!.principal,
      JSON.stringify(event.payload), event.payload!.at,
    ]);
    // No lifecycle INSERT/UPDATE, lease release, advisory acquisition, or dispatch.
    expect(calls.some(call => /(?:INSERT INTO|UPDATE) kernel\.(?:loops|surface_lease)\b/.test(call.text))).toBe(false);
    expect(store.committed).toBe(true);
  });

  it.each([undefined, 'did:imajin:someone-else'])('rejects absent or foreign parent owner %s', async (owner) => {
    store.owner = owner;
    await expect(loopProjectionReactor(stepEvent(), {})).rejects.toBeInstanceOf(LoopOwnershipConflictError);
    expect(calls).toHaveLength(1);
    expect(store.events.size).toBe(0);
    expect(store.committed).toBe(false);
  });

  it.each(['loopId', 'stepId', 'kind', 'principal', 'state', 'summary', 'at'])(
    'rejects missing, blank and non-string %s before any SQL',
    async (field) => {
      for (const value of [undefined, null, '', '   ', 123, {}]) {
        const event = stepEvent();
        event.payload![field] = value;
        await expect(loopProjectionReactor(event, {})).rejects.toThrow(`Invalid step observation: ${field}`);
      }
      expect(calls).toHaveLength(0);
    },
  );

  it.each(['id', 'issuer', 'subject', 'scope'])('rejects missing/empty bus envelope %s', async (field) => {
    for (const value of [undefined, '', '   ']) {
      const event = { ...stepEvent(), [field]: value };
      await expect(loopProjectionReactor(event, {})).rejects.toThrow('Invalid step observation');
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects a missing payload or invalid at rather than replacing it with event.timestamp', async () => {
    await expect(loopProjectionReactor(stepEvent({ payload: undefined }), {})).rejects.toThrow('loopId');
    const event = stepEvent();
    event.payload!.at = 'not-a-timestamp';
    await expect(loopProjectionReactor(event, {})).rejects.toThrow('at must be a valid timestamp');
    await expect(loopProjectionReactor(event, {})).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('retries with the same signed id and deduplicates via ON CONFLICT (id)', async () => {
    const event = stepEvent();
    await loopProjectionReactor(event, {});
    await loopProjectionReactor(event, {});

    const inserts = calls.filter(call => call.text.includes('INSERT INTO kernel.loop_events'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toEqual(inserts[1]);
    expect(inserts.every(call => call.text.includes('ON CONFLICT (id) DO NOTHING'))).toBe(true);
    expect(store.events.size).toBe(1);
    expect(store.events.get(event.id)?.[0]).toBe(event.id);
  });

  it('propagates history failure without committing or writing lifecycle state', async () => {
    store.failHistory = true;
    await expect(loopProjectionReactor(stepEvent({ type: 'step.finished' }), {})).rejects.toThrow('history unavailable');
    expect(store.committed).toBe(false);
    expect(store.events.size).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('ignores unknown step types', async () => {
    await loopProjectionReactor(stepEvent({ type: 'step.dispatch' }), {});
    expect(calls).toHaveLength(0);
  });
});
