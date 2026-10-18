import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEventMap } from '../src/types';

const { projection, emit } = vi.hoisted(() => ({
  projection: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('@imajin/db', () => ({ getClient: () => () => Promise.resolve([]) }));
vi.mock('../src/registry', () => ({
  getReactor: (type: string) => type === 'loop-projection' ? projection : emit,
}));
vi.mock('../src/subscriptions', () => ({ deliverToSubscribers: vi.fn().mockResolvedValue(undefined) }));

import { getChainConfig } from '../src/config';
import { publish } from '../src/publish';
import { LoopOwnershipConflictError } from '../src/reactors/loop-projection';

const STEP_TYPES = [
  'step.queued', 'step.updated', 'step.claimed', 'step.started', 'step.progress',
  'step.blocked', 'step.finished', 'step.observed', 'step.attested',
] as const satisfies ReadonlyArray<keyof BusEventMap>;

const event = {
  id: 'signed:step-observation',
  issuer: 'did:imajin:publisher',
  subject: 'did:imajin:owner',
  scope: 'loop',
  payload: {
    loopId: 'loop_1', stepId: 'step_1', kind: 'review', principal: 'did:imajin:owner',
    state: 'queued', summary: 'Review change', at: '2026-10-17T00:00:00.000Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  projection.mockResolvedValue(undefined);
  emit.mockResolvedValue(undefined);
});

describe('step fallback chains (#2878)', () => {
  it.each(STEP_TYPES)('awaits projection then Record emission for %s with no DB config', async (type) => {
    const config = await getChainConfig(type, 'loop');
    expect(config.source).toBe('defaults');
    expect(config.reactors).toEqual([
      { type: 'loop-projection', config: {}, await: true, enabled: true },
      { type: 'emit', config: {}, await: true, enabled: true },
    ]);

    let persist = () => {};
    let record = () => {};
    let resolved = false;
    projection.mockImplementation(() => new Promise<void>(resolve => { persist = resolve; }));
    emit.mockImplementation(() => new Promise<void>(resolve => { record = resolve; }));
    const pending = publish(type, event).then(() => { resolved = true; });
    await vi.waitFor(() => expect(projection).toHaveBeenCalledOnce());
    expect(emit).not.toHaveBeenCalled();
    persist();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    expect(resolved).toBe(false);
    record();
    await pending;
    expect(resolved).toBe(true);
    expect(projection.mock.calls[0][0].id).toBe(event.id);
  });

  it.each([new LoopOwnershipConflictError(), new Error('history unavailable')])(
    'propagates projection failure and does not emit %s',
    async (error) => {
      projection.mockRejectedValue(error);
      await expect(publish('step.queued', event)).rejects.toBe(error);
      expect(emit).not.toHaveBeenCalled();
    },
  );
});
