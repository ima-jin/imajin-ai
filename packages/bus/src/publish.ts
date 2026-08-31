import { createLogger } from '@imajin/logger';
import { getChainConfig } from './config';
import { getReactor } from './registry';
import { deliverToSubscribers } from './subscriptions';
import type { BusEvent, BusEventMap, BusEventType } from './types';

const log = createLogger('bus');

export async function publish<T extends BusEventType>(
  type: T,
  event: { issuer: string; subject: string; scope: string; payload: BusEventMap[T]; correlationId?: string; timestamp?: string }
): Promise<void> {
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

  for (const reactor of config.reactors) {
    if (!reactor.enabled) continue;

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
  }
}
