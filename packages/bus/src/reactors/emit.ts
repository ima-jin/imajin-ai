import { emit } from '@imajin/emit';
import { attempt } from '../concurrency';
import type { ReactorHandler } from '../types';

export const emitReactor: ReactorHandler = (event, _config) =>
  attempt(() => {
    emit({
      service: event.scope,
      action: event.type,
      did: event.issuer,
      correlationId: event.correlationId,
      payload: event.payload,
      status: 'success',
    });
  });
