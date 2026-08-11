import { describe, it, expect } from 'vitest';
import { buildTelemetryUsageProjection } from '../telemetry-usage';

const PRINCIPAL = 'did:imajin:ryan';

describe('buildTelemetryUsageProjection', () => {
  it('returns an empty projection when there are no count rows', () => {
    const result = buildTelemetryUsageProjection(PRINCIPAL, [], []);
    expect(result).toEqual({ principal: PRINCIPAL, totalCount: 0, bySchema: [] });
  });

  it('sums the total count across every schema rollup', () => {
    const result = buildTelemetryUsageProjection(
      PRINCIPAL,
      [
        { eventType: 'telemetry.usage', schema: 'usage.tokens', count: 5, firstSeenAt: '2026-08-01T00:00:00Z', lastSeenAt: '2026-08-10T00:00:00Z' },
        { eventType: 'telemetry.error', schema: 'error.rate_limit', count: 2, firstSeenAt: '2026-08-02T00:00:00Z', lastSeenAt: '2026-08-03T00:00:00Z' },
      ],
      [],
    );
    expect(result.totalCount).toBe(7);
    expect(result.bySchema).toHaveLength(2);
  });

  it('formats first/last seen timestamps as ISO strings', () => {
    const result = buildTelemetryUsageProjection(
      PRINCIPAL,
      [
        {
          eventType: 'telemetry.usage',
          schema: 'usage.tokens',
          count: 1,
          firstSeenAt: new Date('2026-08-01T12:00:00Z'),
          lastSeenAt: new Date('2026-08-01T12:00:00Z'),
        },
      ],
      [],
    );
    expect(result.bySchema[0].firstSeenAt).toBe('2026-08-01T12:00:00.000Z');
    expect(result.bySchema[0].lastSeenAt).toBe('2026-08-01T12:00:00.000Z');
  });

  it('sums numeric data fields for telemetry.usage rows sampled for the same schema', () => {
    const result = buildTelemetryUsageProjection(
      PRINCIPAL,
      [
        { eventType: 'telemetry.usage', schema: 'usage.tokens', count: 3, firstSeenAt: '2026-08-01T00:00:00Z', lastSeenAt: '2026-08-03T00:00:00Z' },
      ],
      [
        { schema: 'usage.tokens', data: { input: 100, output: 20 } },
        { schema: 'usage.tokens', data: { input: 50, output: 10 } },
        { schema: 'usage.tokens', data: { input: 10, output: 5 } },
      ],
    );
    expect(result.bySchema[0].totals).toEqual({ input: 160, output: 35 });
  });

  it('omits totals when no usage data rows were sampled for that schema', () => {
    const result = buildTelemetryUsageProjection(
      PRINCIPAL,
      [{ eventType: 'telemetry.usage', schema: 'usage.tokens', count: 1, firstSeenAt: '2026-08-01T00:00:00Z', lastSeenAt: '2026-08-01T00:00:00Z' }],
      [],
    );
    expect(result.bySchema[0].totals).toBeUndefined();
  });

  it('never computes totals for telemetry.error or telemetry.lifecycle rows', () => {
    const result = buildTelemetryUsageProjection(
      PRINCIPAL,
      [{ eventType: 'telemetry.error', schema: 'error.rate_limit', count: 1, firstSeenAt: '2026-08-01T00:00:00Z', lastSeenAt: '2026-08-01T00:00:00Z' }],
      [{ schema: 'error.rate_limit', data: { code: 429 } }],
    );
    expect(result.bySchema[0].totals).toBeUndefined();
  });

  it('ignores non-numeric data fields when summing', () => {
    const result = buildTelemetryUsageProjection(
      PRINCIPAL,
      [{ eventType: 'telemetry.usage', schema: 'usage.model', count: 2, firstSeenAt: '2026-08-01T00:00:00Z', lastSeenAt: '2026-08-02T00:00:00Z' }],
      [
        { schema: 'usage.model', data: { modelId: 'claude', input: 10 } },
        { schema: 'usage.model', data: { modelId: 'claude', input: 5 } },
      ],
    );
    expect(result.bySchema[0].totals).toEqual({ input: 15 });
  });

  it('keeps per-schema data isolated when multiple schemas are sampled', () => {
    const result = buildTelemetryUsageProjection(
      PRINCIPAL,
      [
        { eventType: 'telemetry.usage', schema: 'usage.tokens', count: 1, firstSeenAt: '2026-08-01T00:00:00Z', lastSeenAt: '2026-08-01T00:00:00Z' },
        { eventType: 'telemetry.usage', schema: 'usage.cost', count: 1, firstSeenAt: '2026-08-01T00:00:00Z', lastSeenAt: '2026-08-01T00:00:00Z' },
      ],
      [
        { schema: 'usage.tokens', data: { input: 100 } },
        { schema: 'usage.cost', data: { amount: 0.42 } },
      ],
    );
    const tokens = result.bySchema.find((r) => r.schema === 'usage.tokens');
    const cost = result.bySchema.find((r) => r.schema === 'usage.cost');
    expect(tokens?.totals).toEqual({ input: 100 });
    expect(cost?.totals).toEqual({ amount: 0.42 });
  });

  it('drops count rows for an event type outside the telemetry vocabulary defensively', () => {
    const result = buildTelemetryUsageProjection(
      PRINCIPAL,
      [{ eventType: 'not.telemetry', schema: 'x.y', count: 5, firstSeenAt: '2026-08-01T00:00:00Z', lastSeenAt: '2026-08-01T00:00:00Z' } as never],
      [],
    );
    expect(result.bySchema).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });
});
