import { describe, it, expect } from 'vitest';
import { computeFreshness } from '../freshness';

const NOW = new Date('2026-08-09T12:00:00.000Z');

describe('computeFreshness', () => {
  it('reports green for a source synced less than 24h ago', () => {
    const result = computeFreshness('2026-08-09T00:00:01.000Z', NOW);
    expect(result.level).toBe('green');
    expect(result.warningText).toBeUndefined();
  });

  it('reports yellow for a source synced between 24h and 7 days ago', () => {
    const result = computeFreshness('2026-08-05T12:00:00.000Z', NOW);
    expect(result.level).toBe('yellow');
    expect(result.warningText).toBeUndefined();
  });

  it('reports red with a warning for a source stale for more than 7 days', () => {
    const result = computeFreshness('2026-07-01T12:00:00.000Z', NOW);
    expect(result.level).toBe('red');
    expect(result.warningText).toMatch(/day/);
  });

  it('reports red with a warning for an unparseable lastSync', () => {
    const result = computeFreshness('not-a-date', NOW);
    expect(result.level).toBe('red');
    expect(result.warningText).toBeDefined();
  });

  it('treats exactly 24h as no longer green', () => {
    const result = computeFreshness('2026-08-08T12:00:00.000Z', NOW);
    expect(result.level).toBe('yellow');
  });

  it('treats exactly 7 days as stale', () => {
    const result = computeFreshness('2026-08-02T12:00:00.000Z', NOW);
    expect(result.level).toBe('red');
  });
});
