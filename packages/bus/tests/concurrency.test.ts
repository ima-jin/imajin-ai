import { describe, it, expect } from 'vitest';
import { attempt, forEachSequential, mapWithConcurrency } from '../src/concurrency';

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('forEachSequential', () => {
  it('runs steps one at a time, in order', async () => {
    const log: string[] = [];
    await forEachSequential(['a', 'b', 'c'], async (item, index) => {
      log.push(`start:${item}:${index}`);
      await tick(item === 'a' ? 10 : 0);
      log.push(`end:${item}`);
    });
    expect(log).toEqual(['start:a:0', 'end:a', 'start:b:1', 'end:b', 'start:c:2', 'end:c']);
  });

  it('stops at the first rejection and never starts later steps', async () => {
    const started: number[] = [];
    await expect(
      forEachSequential([1, 2, 3], async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });

  it('resolves immediately for an empty list', async () => {
    await expect(forEachSequential([], async () => undefined)).resolves.toBeUndefined();
  });
});

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 0, 10], 8, async (ms, i) => {
      await tick(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:0', '2:10']);
  });

  it('never has more than `limit` calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(2);
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });

  it('treats a limit below 1 as 1 and handles empty input', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(1);
      inFlight--;
    });
    expect(peak).toBe(1);
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });

  it('rejects when any call rejects', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 3) throw new Error('nope');
        return n;
      })
    ).rejects.toThrow('nope');
  });
});

describe('attempt', () => {
  it('resolves with the return value', async () => {
    await expect(attempt(() => 42)).resolves.toBe(42);
  });

  it('turns a synchronous throw into a rejection instead of throwing', async () => {
    let pending: Promise<never> | undefined;
    expect(() => {
      pending = attempt((): never => {
        throw new Error('sync boom');
      });
    }).not.toThrow();
    await expect(pending).rejects.toThrow('sync boom');
  });
});
