import { emit } from '@imajin/emit';
import { attempt } from '../concurrency';
import type { ReactorHandler } from '../types';

/** config.fields limits the emitted payload to listed keys, as in audit-log. */
export const emitReactor: ReactorHandler = (event, config) =>
  attempt(() => {
    let payload = event.payload;
    if (Array.isArray(config.fields)) {
      const source = event.payload ?? {};
      payload = {};
      for (const key of config.fields) {
        if (typeof key === 'string' && key in source) {
          payload[key] = source[key];
        }
      }
    }
    emit({
      service: event.scope,
      action: event.type,
      did: event.issuer,
      correlationId: event.correlationId,
      payload,
      status: 'success',
    });
  });
