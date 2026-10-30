import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let rateLimit: typeof import('../src/rate-limit')['rateLimit'];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
  vi.resetModules();
  ({ rateLimit } = await import('../src/rate-limit'));
});

afterEach(() => vi.useRealTimers());

describe('rateLimit window retention', () => {
  it('retains an hourly window across idle cleanup and allows exactly at expiry', () => {
    expect(rateLimit('hourly', 1, 3600000).limited).toBe(false);
    vi.advanceTimersByTime(180000);
    rateLimit('unrelated', 1, 1000);
    expect(rateLimit('hourly', 1, 3600000)).toEqual({ limited: true, retryAfter: 3420 });
    vi.advanceTimersByTime(3419999);
    expect(rateLimit('hourly', 1, 3600000).limited).toBe(true);
    vi.advanceTimersByTime(1);
    expect(rateLimit('hourly', 1, 3600000).limited).toBe(false);
  });

  it('preserves independent keys and ordinary short-window behavior', () => {
    expect(rateLimit('short', 2, 1000).limited).toBe(false);
    expect(rateLimit('short', 2, 1000).limited).toBe(false);
    expect(rateLimit('short', 2, 1000)).toEqual({ limited: true, retryAfter: 1 });
    expect(rateLimit('other', 1, 1000).limited).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(rateLimit('short', 2, 1000).limited).toBe(false);
    vi.advanceTimersByTime(120000);
    expect(rateLimit('short', 2, 1000).limited).toBe(false);
  });

  it('does not shorten an existing long window when a key is reused with a shorter one', () => {
    rateLimit('shared', 1, 3600000);
    rateLimit('shared', 1, 1000);
    vi.advanceTimersByTime(180000);
    rateLimit('cleanup', 1, 1000);
    expect(rateLimit('shared', 1, 3600000).limited).toBe(true);
  });
});
