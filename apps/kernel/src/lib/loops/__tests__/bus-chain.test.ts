import { beforeEach, describe, expect, it, vi } from 'vitest';
const { emit, register } = vi.hoisted(() => ({ emit: vi.fn(), register: vi.fn() }));
vi.mock('../emit', () => ({ emitKernelLoopEvent: emit }));
vi.mock('@imajin/bus', () => ({ registerChainObserver: register }));
import { emitBusChainLoop, ensureBusChainObserverRegistered } from '../bus-chain';

const observation = {
  invocationId: 'bus_unique', phase: 'started' as const, failed: false, at: '2026-10-16T00:00:00Z',
  event: { type: 'action.proposed', issuer: 'did:imajin:owner', subject: 'did:imajin:other', scope: 'github', correlationId: 'not-a-loop' },
};
beforeEach(() => vi.clearAllMocks());
describe('kernel bus-chain witness', () => {
  it('registers the kernel callback without bus importing kernel', () => {
    ensureBusChainObserverRegistered();
    expect(register).toHaveBeenCalledWith(emitBusChainLoop);
  });
  it('uses a real invocation id and issuer DID, never inferring parent lineage', async () => {
    await emitBusChainLoop(observation);
    expect(emit).toHaveBeenCalledWith('loop.started', expect.objectContaining({
      loopId: 'bus_unique', principal: 'did:imajin:owner', kind: 'bus.chain', state: 'running', sourceCorrelationId: 'not-a-loop',
    }));
    expect(emit.mock.calls[0][1].parentLoopId).toBeUndefined();
  });
  it.each([[false, 'completed'], [true, 'failed']] as const)('reports settled chain outcome %s', async (failed, state) => {
    await emitBusChainLoop({ ...observation, phase: 'finished', failed });
    expect(emit).toHaveBeenCalledWith('loop.finished', expect.objectContaining({ state }));
  });
  it.each(['loop.started', 'loop.progress', 'loop.finished'])('never recursively observes %s', async (type) => {
    await emitBusChainLoop({ ...observation, event: { ...observation.event, type } });
    expect(emit).not.toHaveBeenCalled();
  });
  it('does not invent a principal for legacy non-DID issuers', async () => {
    await emitBusChainLoop({ ...observation, event: { ...observation.event, issuer: 'system' } });
    expect(emit).not.toHaveBeenCalled();
  });
  it.each([
    ['warp.agent.dispatched', { principalDid: 'did:imajin:principal' }],
    ['warp.run.completed', { principalDid: 'did:imajin:principal' }],
    ['mail.sent', { onBehalfOf: 'did:imajin:principal' }],
    ['mail.received', { onBehalfOf: 'did:imajin:principal' }],
    ['drive.file.changed', { onBehalfOf: 'did:imajin:principal' }],
    ['meet.transcript.available', { onBehalfOf: 'did:imajin:principal' }],
    ['usage.incurred', { actingFor: 'did:imajin:principal' }],
  ] as const)('uses the explicit known onBehalfOf field for %s', async (type, payload) => {
    await emitBusChainLoop({ ...observation, event: { ...observation.event, type, payload } });
    expect(emit).toHaveBeenCalledWith('loop.started', expect.objectContaining({ principal: 'did:imajin:principal' }));
  });
  it('never guesses principal from subject or arbitrary payload fields', async () => {
    await emitBusChainLoop({ ...observation, event: {
      ...observation.event, payload: { principalDid: 'did:imajin:arbitrary', onBehalfOf: 'did:imajin:arbitrary', actingFor: 'did:imajin:arbitrary' },
    } });
    expect(emit).toHaveBeenCalledWith('loop.started', expect.objectContaining({ principal: observation.event.issuer }));
  });
  it.each(['warp.run.completed', 'mail.sent', 'usage.incurred'])('does not invent missing explicit principal for %s', async (type) => {
    await emitBusChainLoop({ ...observation, event: { ...observation.event, type, payload: {} } });
    expect(emit).not.toHaveBeenCalled();
  });
});
