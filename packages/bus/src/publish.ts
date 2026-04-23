/**
 * bus.publish() — dispatch a BusEvent to all registered reactors.
 *
 * Runs all reactors concurrently via Promise.allSettled so a single reactor
 * failure never silences others. Errors are caught by each reactor individually.
 */

import { createLogger } from '@imajin/logger';
import { registry } from './registry';
import type { BusEvent, BusEventType, BusPayload } from './types';

const log = createLogger('bus');

export async function publish<T extends BusEventType>(
  type: T,
  payload: BusPayload<T>,
): Promise<void> {
  const reactors = registry[type];
  if (!reactors?.length) return;

  const results = await Promise.allSettled(
    reactors.map((reactor) => Promise.resolve(reactor(payload))),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      log.error({ type, err: String(result.reason) }, '[bus] reactor threw unexpectedly');
    }
  }
}

/** Convenience: fire-and-forget publish — attach .catch() at the call site if needed. */
export const bus = { publish };
