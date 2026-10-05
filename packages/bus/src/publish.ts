import { createLogger } from '@imajin/logger';
import { forEachSequential } from './concurrency';
import { getChainConfig } from './config';
import { getReactor } from './registry';
import { deliverToSubscribers } from './subscriptions';
import type { BusEvent, BusEventMap, BusEventType } from './types';

const log = createLogger('bus');

/**
 * What `publish()` hands back to its caller (#2444). Every field is optional and
 * only populated when a reactor in the event's chain produced it, so callers
 * that ignore the result (the vast majority) are unaffected.
 */
export interface PublishResult {
  /**
   * Id of the attestation created by an awaited `attestation` reactor in this
   * event's chain (the reactor stashes it onto the shared event payload — see
   * `reactors/attestation.ts`). Absent when the chain has no awaited
   * attestation reactor, or attestation forwarding failed/was disabled.
   */
  attestationId?: string;
}

export async function publish<T extends BusEventType>(
  type: T,
  event: { issuer: string; subject: string; scope: string; payload: BusEventMap[T]; correlationId?: string; timestamp?: string }
): Promise<PublishResult> {
  const fullEvent: BusEvent = {
    ...event,
    type,
    timestamp: event.timestamp || new Date().toISOString(),
  };

  // Grant-bound event-subscription fan-out (#1884) — independent of the
  // configured reactor chain below: entitlement is derived from #1882's live
  // grants, not bus_chain_configs, so it must run for every event type
  // uniformly, including ones with no chain config at all. Fire-and-forget;
  // never blocks or fails the publish call.
  deliverToSubscribers(fullEvent).catch((err: unknown) => {
    log.error({ err: String(err), event: type }, 'Event-subscription fan-out failed');
  });

  const config = await getChainConfig(type, event.scope);

  // Structured chain-resolution log (#1859) — makes a chain silently missing
  // an expected reactor discoverable from logs alone, without diffing source.
  // Debug-level: available when diagnosing notification failures, but does
  // not add noise in production.
  log.debug(
    {
      event: type,
      scope: event.scope,
      reactorCount: config.reactors.length,
      reactorTypes: config.reactors.map((r) => r.type),
      source: config.source,
    },
    'Resolved reactor chain for publish()'
  );

  // Load-time validation: every reactor referenced by the chain must be
  // registered. Fail loudly at chain-resolution time instead of silently
  // skipping at request time (#1872).
  const missing = config.reactors
    .filter((r) => r.enabled)
    .map((r) => r.type)
    .filter((t) => !getReactor(t));
  if (missing.length > 0) {
    throw new Error(
      `Unknown reactor(s) in chain for eventType=${config.eventType} scope=${config.scope ?? 'null'}: ${missing.join(', ')}`
    );
  }

  // Sequential on purpose: chain order is the contract — an awaited reactor
  // (e.g. `attestation`) must finish before the next one reads what it stashed
  // on the shared event (e.g. `attestationId` for `mjn`).
  await forEachSequential(config.reactors, async (reactor) => {
    if (!reactor.enabled) return;

    const handler = getReactor(reactor.type)!;

    try {
      if (reactor.await) {
        await handler(fullEvent, reactor.config);
      } else {
        handler(fullEvent, reactor.config).catch((err: unknown) => {
          log.error({ err: String(err), reactor: reactor.type, event: type }, 'Reactor failed');
        });
      }
    } catch (err) {
      log.error({ err: String(err), reactor: reactor.type, event: type }, 'Reactor threw');
    }
  });

  const attestationId = fullEvent.payload?.attestationId;
  return typeof attestationId === 'string' ? { attestationId } : {};
}
