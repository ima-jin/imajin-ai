import { emit } from '@imajin/emit';
import type { ReactorHandler } from '../types';

export const emitReactor: ReactorHandler = async (event, _config) => {
  emit({
    service: event.scope,
    action: event.type,
    did: event.issuer,
    correlationId: event.correlationId,
    payload: event.payload,
    status: 'success',
  });
};
