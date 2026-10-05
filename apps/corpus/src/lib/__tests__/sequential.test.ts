import { describe, expect, it } from 'vitest';
import { mapSequentially } from '../sequential.js';

describe('mapSequentially', () => {
  it('resolves to an empty array for no items', async () => {
    await expect(mapSequentially([], async () => 1)).resolves.toEqual([]);
  });

  it('returns results in input order and passes the index', async () => {
    const result = await mapSequentially(['a', 'b', 'c'], async (item, index) => `${item}${index}`);
    expect(result).toEqual(['a0', 'b1', 'c2']);
  });

  it('starts each call only after the previous one resolved', async () => {
    const events: string[] = [];
    const delays = [30, 5, 15];
    await mapSequentially(delays, async (delay, index) => {
      events.push(`start-${index}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      events.push(`end-${index}`);
    });
    expect(events).toEqual(['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('rejects with the first error and never starts later items', async () => {
    const started: number[] = [];
    const failure = new Error('boom');
    const promise = mapSequentially([1, 2, 3], async item => {
      started.push(item);
      if (item === 2) throw failure;
      return item;
    });
    await expect(promise).rejects.toBe(failure);
    expect(started).toEqual([1, 2]);
  });

  it('turns a synchronous throw from fn into a rejection', async () => {
    const promise = mapSequentially([1], () => {
      throw new Error('sync');
    });
    await expect(promise).rejects.toThrow('sync');
  });
});
