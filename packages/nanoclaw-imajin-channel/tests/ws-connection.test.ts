import { describe, expect, it } from 'vitest';
import { computeReconnectDelayMs } from '../src/ws-connection.js';

describe('computeReconnectDelayMs', () => {
  it('grows exponentially, capped at 60s', () => {
    expect(computeReconnectDelayMs(0)).toBe(2_000);
    expect(computeReconnectDelayMs(1)).toBe(4_000);
    expect(computeReconnectDelayMs(2)).toBe(8_000);
    expect(computeReconnectDelayMs(10)).toBe(60_000);
  });
});
