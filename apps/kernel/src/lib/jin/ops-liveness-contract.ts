export const OPS_LIVENESS_ACTION = 'ops.liveness.restart';

export interface LivenessEvent {
  id: string;
  app: string;
  port: number;
  outcome: 'requested' | 'restarted' | 'restart-failed';
  failures: number;
  at: string;
}

/** Whitelist fields; never persist a probe's headers, raw errors or bodies. */
export function parseLivenessEvent(value: unknown): LivenessEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.id)
    || typeof event.app !== 'string' || !/^(dev|prod)-[a-z0-9-]{1,60}$/.test(event.app)
    || !Number.isSafeInteger(event.port) || (event.port as number) < 1 || (event.port as number) > 65535
    || !Number.isSafeInteger(event.failures) || (event.failures as number) < 1 || (event.failures as number) > 100
    || !['requested', 'restarted', 'restart-failed'].includes(event.outcome as string)
    || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))
    || new Date(event.at).toISOString() !== event.at) return null;
  return {
    id: event.id, app: event.app, port: event.port as number,
    outcome: event.outcome as LivenessEvent['outcome'],
    failures: event.failures as number, at: event.at,
  };
}
