import { createLogger } from '@imajin/logger';
import type { BusEvent } from './types';

export interface ChainObservation {
  invocationId: string;
  event: BusEvent;
  phase: 'started' | 'finished';
  failed: boolean;
  at: string;
}

export type ChainObserver = (observation: ChainObservation) => Promise<void>;
let observer: ChainObserver | undefined;
const log = createLogger('bus:chain-observer');

/** Kernel injects its signed loop publisher; bus has no upward app dependency. */
export function registerChainObserver(value: ChainObserver | undefined): void {
  observer = value;
}

export async function observeChain(observation: ChainObservation): Promise<void> {
  // Ingest itself publishes loop.*. Observing that chain would recurse forever.
  if (!observer || observation.event.type.startsWith('loop.')) return;
  try {
    await observer(observation);
  } catch (err) {
    log.warn({ err: String(err), invocationId: observation.invocationId }, 'Chain observer failed (non-fatal)');
  }
}
