import { describe, it, expect } from 'vitest';
import { validateTelemetryEventBatch, MAX_TELEMETRY_BATCH_SIZE } from '../telemetry-ingest';

function usageEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'telemetry.usage',
    schema: 'usage.tokens',
    data: { input: 120, output: 45, cacheRead: 0 },
    ...overrides,
  };
}

describe('validateTelemetryEventBatch — envelope', () => {
  it('rejects a non-array events value', () => {
    const result = validateTelemetryEventBatch({ not: 'an array' });
    expect(result).toEqual({ error: 'events must be an array' });
  });

  it('rejects an empty batch', () => {
    const result = validateTelemetryEventBatch([]);
    expect(result).toEqual({ error: 'events must not be empty' });
  });

  it('rejects a batch over the size cap', () => {
    const events = Array.from({ length: MAX_TELEMETRY_BATCH_SIZE + 1 }, () => usageEvent());
    const result = validateTelemetryEventBatch(events);
    expect(result).toEqual({ error: `events may not exceed ${MAX_TELEMETRY_BATCH_SIZE} per request` });
  });

  it('accepts a batch right at the size cap', () => {
    const events = Array.from({ length: MAX_TELEMETRY_BATCH_SIZE }, () => usageEvent());
    const result = validateTelemetryEventBatch(events);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.accepted).toHaveLength(MAX_TELEMETRY_BATCH_SIZE);
      expect(result.rejected).toHaveLength(0);
    }
  });
});

describe('validateTelemetryEventBatch — per-event validation', () => {
  it('accepts a well-formed telemetry.usage event', () => {
    const result = validateTelemetryEventBatch([usageEvent()]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.accepted).toEqual([
        { type: 'telemetry.usage', schema: 'usage.tokens', data: { input: 120, output: 45, cacheRead: 0 } },
      ]);
      expect(result.rejected).toHaveLength(0);
    }
  });

  it('carries optional sessionRef and agent through when present', () => {
    const result = validateTelemetryEventBatch([
      usageEvent({ sessionRef: 'run_abc123', agent: 'did:imajin:jin-agent' }),
    ]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.accepted[0]).toEqual({
        type: 'telemetry.usage',
        schema: 'usage.tokens',
        data: { input: 120, output: 45, cacheRead: 0 },
        sessionRef: 'run_abc123',
        agent: 'did:imajin:jin-agent',
      });
    }
  });

  it('accepts telemetry.error and telemetry.lifecycle types', () => {
    const result = validateTelemetryEventBatch([
      usageEvent({ type: 'telemetry.error', schema: 'error.rate_limit', data: { code: 429 } }),
      usageEvent({ type: 'telemetry.lifecycle', schema: 'lifecycle.session', data: { state: 'started' } }),
    ]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.accepted).toHaveLength(2);
      expect(result.rejected).toHaveLength(0);
    }
  });

  it('rejects an unknown event type without sinking the rest of the batch', () => {
    const result = validateTelemetryEventBatch([usageEvent({ type: 'telemetry.bogus' }), usageEvent()]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toEqual([
        { index: 0, reason: 'type must be one of telemetry.usage, telemetry.error, telemetry.lifecycle' },
      ]);
    }
  });

  it.each(['usage', 'usage.', '.tokens', 'Usage.Tokens', 'usage tokens', ''])(
    'rejects a malformed schema key %j',
    (schema) => {
      const result = validateTelemetryEventBatch([usageEvent({ schema })]);
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.rejected).toEqual([
          { index: 0, reason: 'schema must be a namespaced key, e.g. "usage.tokens"' },
        ]);
      }
    },
  );

  it('rejects data that is not an object', () => {
    const result = validateTelemetryEventBatch([usageEvent({ data: 'not-an-object' })]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.rejected).toEqual([{ index: 0, reason: 'data must be an object' }]);
    }
  });

  it('rejects an empty data object', () => {
    const result = validateTelemetryEventBatch([usageEvent({ data: {} })]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.rejected).toEqual([{ index: 0, reason: 'data must have at least one field' }]);
    }
  });

  it('rejects data with more than 50 fields', () => {
    const data = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, i]));
    const result = validateTelemetryEventBatch([usageEvent({ data })]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.rejected).toEqual([{ index: 0, reason: 'data may carry at most 50 fields' }]);
    }
  });

  it('rejects a nested object value inside data', () => {
    const result = validateTelemetryEventBatch([usageEvent({ data: { input: 1, nested: { a: 1 } } })]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.rejected).toEqual([
        { index: 0, reason: 'data.nested must be a string, number, boolean, or null' },
      ]);
    }
  });

  it('rejects an array value inside data', () => {
    const result = validateTelemetryEventBatch([usageEvent({ data: { input: [1, 2, 3] } })]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.rejected).toEqual([
        { index: 0, reason: 'data.input must be a string, number, boolean, or null' },
      ]);
    }
  });

  it('accepts null and boolean primitive values inside data', () => {
    const result = validateTelemetryEventBatch([usageEvent({ data: { active: true, note: null, label: 'x' } })]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.accepted[0].data).toEqual({ active: true, note: null, label: 'x' });
    }
  });

  it('rejects a non-string sessionRef', () => {
    const result = validateTelemetryEventBatch([usageEvent({ sessionRef: 42 })]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.rejected).toEqual([{ index: 0, reason: 'sessionRef must be a string when present' }]);
    }
  });

  it('rejects a non-object event entry', () => {
    const result = validateTelemetryEventBatch(['not-an-object']);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.rejected).toEqual([{ index: 0, reason: 'event must be an object' }]);
    }
  });

  it('validates each event independently, preserving index correlation', () => {
    const result = validateTelemetryEventBatch([usageEvent(), usageEvent({ schema: 'bad schema' }), usageEvent()]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.accepted).toHaveLength(2);
      expect(result.rejected).toEqual([
        { index: 1, reason: 'schema must be a namespaced key, e.g. "usage.tokens"' },
      ]);
    }
  });
});
