import { registerChainObserver, type ChainObservation } from '@imajin/bus';
import { emitKernelLoopEvent } from './emit';

/** One loop per real publish invocation; correlationId is not a lifecycle. */
export async function emitBusChainLoop(observation: ChainObservation): Promise<void> {
  const { invocationId, event, phase, failed, at } = observation;
  if (event.type.startsWith('loop.') || !event.issuer.startsWith('did:')) return;
  await emitKernelLoopEvent(phase === 'started' ? 'loop.started' : 'loop.finished', {
    loopId: invocationId,
    kind: 'bus.chain',
    principal: event.issuer,
    state: phase === 'started' ? 'running' : terminalState(failed),
    summary: `${event.type} reactor chain ${phase}`,
    at,
    sourceEventType: event.type,
    sourceScope: event.scope,
    // Trace only, explicitly not parentLoopId or inferred registry linkage.
    sourceCorrelationId: event.correlationId ?? null,
  });
}
function terminalState(failed: boolean): string {
  return failed ? 'failed' : 'completed';
}

export function ensureBusChainObserverRegistered(): void {
  registerChainObserver(emitBusChainLoop);
}
