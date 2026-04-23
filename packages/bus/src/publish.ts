import { createLogger } from '@imajin/logger';
import { getChainConfig } from './config';
import { getReactor } from './registry';
import type { BusEvent } from './types';

const log = createLogger('bus');

export async function publish(type: string, event: Omit<BusEvent, 'type'>): Promise<void> {
  const fullEvent: BusEvent = {
    ...event,
    type,
    timestamp: event.timestamp || new Date().toISOString(),
  };

  const config = getChainConfig(type, event.scope);

  for (const reactor of config.reactors) {
    if (!reactor.enabled) continue;

    const handler = getReactor(reactor.type);
    if (!handler) {
      log.warn({ reactor: reactor.type, event: type }, 'Unknown reactor type');
      continue;
    }

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
