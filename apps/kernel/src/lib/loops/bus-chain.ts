import { registerChainObserver, type BusEvent, type ChainObservation } from '@imajin/bus';
import { emitKernelLoopEvent } from './emit';

const WARP_PRINCIPAL_EVENTS = new Set([
  'warp.agent.dispatched', 'warp.run.resumed', 'warp.run.still_running',
  'warp.run.completed', 'warp.run.failed', 'warp.run.blocked', 'warp.run.progress', 'warp.run.timeout',
]);
const GOOGLE_ON_BEHALF_OF_EVENTS = new Set([
  'mail.received', 'mail.sent', 'drive.file.changed', 'meet.transcript.available',
]);

function chainPrincipal(event: BusEvent): string | undefined {
  let principal: unknown = event.issuer;
  // These fields have explicit onBehalfOf semantics in BusEventMap. Do not
  // promote similarly named fields from arbitrary event payloads to authority.
  if (WARP_PRINCIPAL_EVENTS.has(event.type)) principal = event.payload?.principalDid;
  else if (GOOGLE_ON_BEHALF_OF_EVENTS.has(event.type)) principal = event.payload?.onBehalfOf;
  else if (event.type === 'usage.incurred') principal = event.payload?.actingFor;
  return typeof principal === 'string' && principal.startsWith('did:') && principal.length > 4 ? principal : undefined;
}

/** One loop per real publish invocation; correlationId is not a lifecycle. */
export async function emitBusChainLoop(observation: ChainObservation): Promise<void> {
  const { invocationId, event, phase, failed, at } = observation;
  if (event.type.startsWith('loop.')) return;
  const principal = chainPrincipal(event);
  if (!principal) return;
  await emitKernelLoopEvent(phase === 'started' ? 'loop.started' : 'loop.finished', {
    loopId: invocationId,
    kind: 'bus.chain',
    principal,
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
