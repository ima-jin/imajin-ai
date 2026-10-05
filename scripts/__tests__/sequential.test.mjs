import { describe, expect, it } from 'vitest';
import { mapSequentially } from '../lib/sequential.mjs';

describe('scripts/lib/sequential mapSequentially', () => {
  it('resolves to an empty array for no items', async () => {
    await expect(mapSequentially([], async () => 1)).resolves.toEqual([]);
  });

  it('returns results in input order and passes the index', async () => {
    const result = await mapSequentially(new Set(['a', 'b']), async (item, index) => `${item}${index}`);
    expect(result).toEqual(['a0', 'b1']);
  });

  it('runs one call at a time', async () => {
    const events = [];
    await mapSequentially([20, 1], async (delay, index) => {
      events.push(`start-${index}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`end-${index}`);
    });
    expect(events).toEqual(['start-0', 'end-0', 'start-1', 'end-1']);
  });

  it('stops at the first rejection', async () => {
    const started = [];
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
