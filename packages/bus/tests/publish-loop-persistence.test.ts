import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEventMap } from '../src/types';

const { getChainConfig, handler, emitHandler, subscriptionHandler } = vi.hoisted(() => ({
  getChainConfig: vi.fn(),
  handler: vi.fn(),
  emitHandler: vi.fn(),
  subscriptionHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/config', () => ({ getChainConfig }));
vi.mock('../src/subscriptions', () => ({ deliverToSubscribers: subscriptionHandler }));
vi.mock('../src/registry', () => ({
  getReactor: (type: string) => type === 'emit' ? emitHandler : handler,
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), debug: vi.fn() }),
}));

import { publish } from '../src/publish';
import { LoopOwnershipConflictError } from '../src/reactors/loop-projection';

const event = {
  issuer: 'did:imajin:publisher',
  subject: 'did:imajin:owner',
  scope: 'loop',
  payload: {
    loopId: 'loop_1', kind: 'warp.run', principal: 'did:imajin:owner',
    state: 'running', summary: 'Working', at: '2026-09-22T00:00:00.000Z',
  } as BusEventMap['loop.progress'],
};

function chain(type = 'loop-projection', awaited = true) {
  getChainConfig.mockResolvedValue({
    eventType: 'loop.progress', scope: 'loop', source: 'test',
    reactors: [
      { type, enabled: true, await: awaited, config: {} },
      { type: 'emit', enabled: true, await: true, config: {} },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  handler.mockResolvedValue(undefined);
  emitHandler.mockResolvedValue(undefined);
  chain();
});

describe('publish loop persistence contract', () => {
  it.each([new LoopOwnershipConflictError(), new Error('database unavailable')])(
    'rejects on awaited projection error %s without running subsequent reactors',
    async (error) => {
      handler.mockRejectedValue(error);
      await expect(publish('loop.progress', event)).rejects.toBe(error);
      expect(emitHandler).not.toHaveBeenCalled();
    },
  );

  it('does not resolve until projection persistence completes', async () => {
    let release = () => {};
    handler.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = publish('loop.progress', event);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(emitHandler).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toEqual({});
    expect(emitHandler).toHaveBeenCalledOnce();
  });

  it('preserves swallowed failures for other awaited reactors', async () => {
    chain('notify');
    handler.mockRejectedValue(new Error('notification failed'));
    await expect(publish('loop.progress', event)).resolves.toEqual({});
    expect(emitHandler).toHaveBeenCalledOnce();
  });

  it('preserves fire-and-forget projection behavior when configured unawaited', async () => {
    chain('loop-projection', false);
    handler.mockRejectedValue(new Error('async projection failed'));
    await expect(publish('loop.progress', event)).resolves.toEqual({});
    expect(emitHandler).toHaveBeenCalledOnce();
  });
});
