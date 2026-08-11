/**
 * Telemetry ingestion validation (#1677) — pure, DB-free.
 *
 * The ingestion endpoint (`POST /connections/api/telemetry`) accepts a batch
 * of structured usage events from an external tool and publishes one bus
 * event per valid entry. This module is the validation/normalization layer
 * between "whatever JSON the caller posted" and a well-formed
 * `BusEventMap['telemetry.usage' | 'telemetry.error' | 'telemetry.lifecycle']`
 * payload — kept separate from the route (no request/response, no `publish`)
 * so it is trivially unit-testable, mirroring the
 * `buildConnectorTelemetryRollup` / `readConnectorTelemetry` split in
 * `./connector-telemetry.ts`.
 *
 * Deliberately schema-light for v1: rather than requiring every reporting
 * tool to pre-register a field manifest (the "scope manifest as schema
 * declaration" idea from #1677's design doc), this validates the STRUCTURE
 * every schema must share — a namespaced `schema` key and a flat object of
 * primitive `data` values — which is enough to keep the audit trail and the
 * usage projection queryable without coupling ingestion to a per-connector
 * registry. A declarative per-connector field manifest (rejecting unknown
 * fields, typed units) is a natural v2 once a second real telemetry reporter
 * exists to inform its shape — same scoping call #1799's connector-telemetry
 * rollup made for its GitHub-only action-ledger source.
 */

/** The three telemetry event types the ingestion pattern accepts. */
export const TELEMETRY_EVENT_TYPES = ['telemetry.usage', 'telemetry.error', 'telemetry.lifecycle'] as const;
export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

/** Namespaced schema key, e.g. `usage.tokens`. Mirrors the manifest shape in the issue. */
const SCHEMA_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Primitive JSON scalar — the only value shapes `data` fields may hold. */
type PrimitiveValue = string | number | boolean | null;

/** One validated telemetry event, ready to hand to `publish()`. */
export interface ValidatedTelemetryEvent {
  type: TelemetryEventType;
  schema: string;
  data: Record<string, PrimitiveValue>;
  sessionRef?: string;
  agent?: string;
}

/** Why one event in a batch was rejected, with its index for correlation. */
export interface RejectedTelemetryEvent {
  index: number;
  reason: string;
}

export interface TelemetryBatchValidation {
  accepted: ValidatedTelemetryEvent[];
  rejected: RejectedTelemetryEvent[];
}

/** Hard ceiling on events per request — batch/periodic reporting, not a streaming firehose (#1677 non-goal). */
export const MAX_TELEMETRY_BATCH_SIZE = 200;
/** Hard ceiling on `data` keys per event — usage counters, not an arbitrary payload dump. */
const MAX_DATA_FIELDS = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is PrimitiveValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Validate one raw event. Returns either the normalized event or a rejection reason. */
function validateOne(raw: unknown): { ok: true; event: ValidatedTelemetryEvent } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'event must be an object' };
  }

  const { type, schema, data, sessionRef, agent } = raw;

  if (typeof type !== 'string' || !TELEMETRY_EVENT_TYPES.includes(type as TelemetryEventType)) {
    return { ok: false, reason: `type must be one of ${TELEMETRY_EVENT_TYPES.join(', ')}` };
  }
  if (typeof schema !== 'string' || !SCHEMA_PATTERN.test(schema)) {
    return { ok: false, reason: 'schema must be a namespaced key, e.g. "usage.tokens"' };
  }
  if (!isPlainObject(data)) {
    return { ok: false, reason: 'data must be an object' };
  }
  const dataKeys = Object.keys(data);
  if (dataKeys.length === 0) {
    return { ok: false, reason: 'data must have at least one field' };
  }
  if (dataKeys.length > MAX_DATA_FIELDS) {
    return { ok: false, reason: `data may carry at most ${MAX_DATA_FIELDS} fields` };
  }
  const normalizedData: Record<string, PrimitiveValue> = {};
  for (const key of dataKeys) {
    const value = data[key];
    if (!isPrimitive(value)) {
      return { ok: false, reason: `data.${key} must be a string, number, boolean, or null` };
    }
    normalizedData[key] = value;
  }

  if (sessionRef !== undefined && typeof sessionRef !== 'string') {
    return { ok: false, reason: 'sessionRef must be a string when present' };
  }
  if (agent !== undefined && typeof agent !== 'string') {
    return { ok: false, reason: 'agent must be a string when present' };
  }

  return {
    ok: true,
    event: {
      type: type as TelemetryEventType,
      schema,
      data: normalizedData,
      ...(typeof sessionRef === 'string' ? { sessionRef } : {}),
      ...(typeof agent === 'string' ? { agent } : {}),
    },
  };
}

/**
 * Validate a raw request body's `events` array.
 *
 * Fails the WHOLE batch only for structural problems with the envelope itself
 * (not an array, empty, over the size cap) — those are caller bugs, not
 * per-event data problems. Once the envelope is sound, each event is validated
 * independently: one bad event in a batch of ten does not sink the other nine.
 */
export function validateTelemetryEventBatch(rawEvents: unknown): TelemetryBatchValidation | { error: string } {
  if (!Array.isArray(rawEvents)) {
    return { error: 'events must be an array' };
  }
  if (rawEvents.length === 0) {
    return { error: 'events must not be empty' };
  }
  if (rawEvents.length > MAX_TELEMETRY_BATCH_SIZE) {
    return { error: `events may not exceed ${MAX_TELEMETRY_BATCH_SIZE} per request` };
  }

  const accepted: ValidatedTelemetryEvent[] = [];
  const rejected: RejectedTelemetryEvent[] = [];

  rawEvents.forEach((raw, index) => {
    const result = validateOne(raw);
    if (result.ok) {
      accepted.push(result.event);
    } else {
      rejected.push({ index, reason: result.reason });
    }
  });

  return { accepted, rejected };
}
