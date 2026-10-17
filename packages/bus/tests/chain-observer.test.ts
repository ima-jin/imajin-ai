import { beforeEach, describe, expect, it, vi } from 'vitest';
const { config, reactor, subscribers } = vi.hoisted(() => ({
  config: vi.fn(), reactor: vi.fn(), subscribers: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/config', () => ({ getChainConfig: config }));
vi.mock('../src/registry', () => ({ getReactor: reactor }));
vi.mock('../src/subscriptions', () => ({ deliverToSubscribers: subscribers }));
import { publish } from '../src/publish';
import { registerChainObserver } from '../src/chain-observer';

const event = { issuer: 'did:imajin:owner', subject: 'did:imajin:owner', scope: 'test', payload: { tier: 'hard' }, correlationId: 'trace' };
const observer = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  observer.mockResolvedValue(undefined);
  registerChainObserver(observer);
  config.mockResolvedValue({ eventType: 'session.created', scope: 'test', source: 'defaults', reactors: [{ type: 'test', enabled: true, await: true, config: {} }] });
  reactor.mockReturnValue(vi.fn().mockResolvedValue(undefined));
});

describe('publish chain observer seam', () => {
  it('starts and finishes one actual invocation with a shared id', async () => {
    await publish('session.created', event);
    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls[0][0]).toMatchObject({ phase: 'started', failed: false });
    expect(observer.mock.calls[1][0]).toMatchObject({ phase: 'finished', failed: false, invocationId: observer.mock.calls[0][0].invocationId });
    await publish('session.created', event);
    expect(observer.mock.calls[2][0].invocationId).not.toBe(observer.mock.calls[0][0].invocationId);
  });
  it('does not mark async reactors finished before they settle or block the publisher', async () => {
    let settle!: () => void;
    reactor.mockReturnValue(() => new Promise<void>((resolve) => { settle = resolve; }));
    config.mockResolvedValue({ eventType: 'session.created', scope: null, source: 'defaults', reactors: [{ type: 'test', enabled: true, await: false, config: {} }] });
    await publish('session.created', event);
    expect(observer).toHaveBeenCalledTimes(1);
    settle();
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(2));
    expect(observer.mock.calls[1][0].failed).toBe(false);
  });
  it.each([true, false])('records reactor failure when awaited=%s without changing existing swallow behavior', async (awaited) => {
    reactor.mockReturnValue(vi.fn().mockRejectedValue(new Error('reactor failed')));
    config.mockResolvedValue({ eventType: 'session.created', scope: null, source: 'defaults', reactors: [{ type: 'test', enabled: true, await: awaited, config: {} }] });
    await expect(publish('session.created', event)).resolves.toEqual({});
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(2));
    expect(observer.mock.calls[1][0]).toMatchObject({ phase: 'finished', failed: true });
  });
  it('records unknown reactor failure while preserving the publish rejection', async () => {
    reactor.mockReturnValue(undefined);
    await expect(publish('session.created', event)).rejects.toThrow('Unknown reactor');
    expect(observer.mock.calls[1][0]).toMatchObject({ phase: 'finished', failed: true });
  });
  it('never observes loop.* publications', async () => {
    await publish('loop.started', { ...event, payload: { loopId: 'loop', kind: 'test', principal: event.issuer, state: 'running', summary: 'running', at: new Date().toISOString() } });
    expect(observer).not.toHaveBeenCalled();
  });
  it('does not let observer errors fail actual event delivery', async () => {
    observer.mockRejectedValue(new Error('observation offline'));
    await expect(publish('session.created', event)).resolves.toEqual({});
    expect(reactor).toHaveBeenCalled();
  });
  it('works with no injected observer', async () => {
    registerChainObserver(undefined);
    await expect(publish('session.created', event)).resolves.toEqual({});
    expect(observer).not.toHaveBeenCalled();
  });
});
