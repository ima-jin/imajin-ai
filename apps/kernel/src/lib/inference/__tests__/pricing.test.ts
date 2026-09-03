import { describe, it, expect } from 'vitest';
import { computeCostUsd } from '../pricing';

describe('computeCostUsd', () => {
  it('returns undefined when either token count is unknown (never fabricates a $0)', () => {
    expect(computeCostUsd('xai', 'grok-4', undefined, 100)).toBeUndefined();
    expect(computeCostUsd('xai', 'grok-4', 100, undefined)).toBeUndefined();
    expect(computeCostUsd('xai', 'grok-4', undefined, undefined)).toBeUndefined();
  });

  it('computes cost from a known model rate', () => {
    // claude-sonnet-4-20250514: $3/1M in, $15/1M out.
    const cost = computeCostUsd('anthropic', 'claude-sonnet-4-20250514', 1_000_000, 1_000_000);
    expect(cost).toBe(18);
  });

  it('falls back to the connector default rate for an unrecognized model', () => {
    const known = computeCostUsd('xai', 'grok-4', 1_000_000, 0);
    const unknown = computeCostUsd('xai', 'grok-9-future-model', 1_000_000, 0);
    expect(unknown).toBe(known);
  });

  it('returns 0 for a zero-token call rather than undefined', () => {
    expect(computeCostUsd('openai', 'gpt-4o', 0, 0)).toBe(0);
  });

  it('rounds to 8 decimal places, matching the NUMERIC(20,8) column', () => {
    const cost = computeCostUsd('moonshot', 'kimi-k2-0711-preview', 1, 1);
    expect(cost).toBeCloseTo(0.0000031, 8);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('local inference always costs exactly 0 (#1957) — attribution, not billing', () => {
    expect(computeCostUsd('local', 'llama3', 1_000_000, 1_000_000)).toBe(0);
    expect(computeCostUsd('local', 'any-model-id', 1, 1)).toBe(0);
    // Still undefined (not a fabricated $0) when token counts are unknown —
    // the same rule every other connector follows.
    expect(computeCostUsd('local', 'llama3', undefined, undefined)).toBeUndefined();
  });
});
