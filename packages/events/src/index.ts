import { postgresAdapter } from './adapters/postgres';

export interface SystemEvent {
  service: string;
  action: string;
  did?: string;
  correlationId?: string;
  parentEventId?: string;
  payload?: Record<string, unknown>;
  status?: 'success' | 'failure';
  durationMs?: number;
}

export interface EventAdapter {
  emit(event: SystemEvent): void;
}

export interface ServiceEmitter {
  emit(event: Omit<SystemEvent, 'service'>): void;
}

let _adapter: EventAdapter = postgresAdapter;

/** Override the default adapter (useful for testing or swapping to Inngest). */
export function setAdapter(adapter: EventAdapter): void {
  _adapter = adapter;
}

/** Fire-and-forget event emission. Never throws. */
export function emit(event: SystemEvent): void {
  try {
    _adapter.emit(event);
  } catch {
    // adapter.emit() should never throw, but guard here too
  }
}

/** Create a service-scoped emitter so callers don't repeat the service name. */
export function createEmitter(service: string): ServiceEmitter {
  return {
    emit(event: Omit<SystemEvent, 'service'>): void {
      try {
        _adapter.emit({ ...event, service });
      } catch {
        // never throw
      }
    },
  };
}
