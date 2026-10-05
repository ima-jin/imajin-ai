import { describe, expect, it } from 'vitest';
import { mapSequentially } from '../sequential';

describe('mapSequentially', () => {
  it('resolves to an empty array for no items', async () => {
    await expect(mapSequentially([], async () => 1)).resolves.toEqual([]);
  });

  it('returns results in input order and passes the index', async () => {
    const result = await mapSequentially(['a', 'b'], async (item, index) => `${item}${index}`);
    expect(result).toEqual(['a0', 'b1']);
  });

  it('starts each call only after the previous one resolved', async () => {
    const events: string[] = [];
    await mapSequentially([20, 1], async (delay, index) => {
      events.push(`start-${index}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`end-${index}`);
    });
    expect(events).toEqual(['start-0', 'end-0', 'start-1', 'end-1']);
  });

  it('rejects with the first error and never starts later items', async () => {
    const started: number[] = [];
    const failure = new Error('boom');
    await expect(
      mapSequentially([1, 2, 3], async (item) => {
        started.push(item);
        if (item === 2) throw failure;
      }),
    ).rejects.toBe(failure);
    expect(started).toEqual([1, 2]);
  });
});
