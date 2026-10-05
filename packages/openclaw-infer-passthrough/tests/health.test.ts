import { describe, it, expect } from 'vitest';
import { HealthTracker } from '../src/health.js';

describe('HealthTracker passthrough liveness (#2453)', () => {
  const fixedNow = () => Date.parse('2026-01-02T03:04:05.000Z');

  it('starts healthy with no recorded error', () => {
    const snapshot = new HealthTracker(fixedNow).snapshot();
    expect(snapshot).toMatchObject({ passthroughOk: true, passthroughErrorCount: 0, lastPassthroughError: null });
  });

  it('records any 5xx status and marks the passthrough unhealthy', () => {
    const health = new HealthTracker(fixedNow);
    health.recordPassthroughStatus(502);
    health.recordPassthroughStatus(500);
    expect(health.snapshot()).toMatchObject({
      passthroughOk: false,
      passthroughErrorCount: 2,
      lastPassthroughError: { status: 500, at: '2026-01-02T03:04:05.000Z' },
    });
  });

  it('recovers on a 2xx but keeps the last error for diagnosis', () => {
    const health = new HealthTracker(fixedNow);
    health.recordPassthroughStatus(502);
    health.recordPassthroughStatus(200);
    expect(health.snapshot()).toMatchObject({ passthroughOk: true, passthroughErrorCount: 1, lastPassthroughError: { status: 502 } });
  });

  it('leaves the state untouched on a 4xx', () => {
    const health = new HealthTracker(fixedNow);
    health.recordPassthroughStatus(404);
    expect(health.snapshot().passthroughOk).toBe(true);
    health.recordPassthroughStatus(502);
    health.recordPassthroughStatus(401);
    expect(health.snapshot()).toMatchObject({ passthroughOk: false, passthroughErrorCount: 1 });
  });

  it('does not affect kernelOk or the fallback counters', () => {
    const health = new HealthTracker(fixedNow);
    health.recordPassthroughStatus(502);
    expect(health.snapshot()).toMatchObject({ kernelOk: true, fallbackCount: 0, fallbackRate: 0 });
  });
});
