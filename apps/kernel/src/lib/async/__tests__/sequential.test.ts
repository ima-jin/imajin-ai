import { describe, it, expect } from 'vitest';
import { forEachSequential, mapWithConcurrency, forEachPage } from '../sequential';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('forEachSequential', () => {
  it('runs steps in order without overlap', async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await forEachSequential([3, 1, 2], async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start:${n}`);
      await tick(n);
      events.push(`end:${n}`);
      inFlight--;
    });
    expect(maxInFlight).toBe(1);
    expect(events).toEqual(['start:3', 'end:3', 'start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('passes the item index and accepts any iterable', async () => {
    const seen: Array<[string, number]> = [];
    await forEachSequential(new Set(['a', 'b']), async (item, index) => {
      seen.push([item, index]);
    });
    expect(seen).toEqual([['a', 0], ['b', 1]]);
  });

  it('resolves immediately for an empty list', async () => {
    await expect(forEachSequential([], async () => { throw new Error('never'); })).resolves.toBeUndefined();
  });

  it('stops at the first rejection and does not start later steps', async () => {
    const ran: number[] = [];
    await expect(
      forEachSequential([1, 2, 3], async (n) => {
        ran.push(n);
        if (n === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(ran).toEqual([1, 2]);
  });
});

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 1, 10, 5], 4, async (ms, i) => {
      await tick(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:1', '2:10', '3:5']);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(2);
      inFlight--;
    });
    expect(maxInFlight).toBe(3);
  });

  it('clamps a non-positive limit to 1', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight--;
    });
    expect(maxInFlight).toBe(1);
  });

  it('propagates a rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('nope');
        return n;
      }),
    ).rejects.toThrow('nope');
  });
});

describe('forEachPage', () => {
  it('follows the cursor until it is exhausted, one page at a time', async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      start: { items: [1, 2], next: 'p2' },
      p2: { items: [3], next: 'p3' },
      p3: { items: [4] },
    };
    const requested: Array<string | undefined> = [];
    const collected: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    await forEachPage(
      async (cursor) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        requested.push(cursor);
        await tick();
        inFlight--;
        return pages[cursor ?? 'start'];
      },
      (page) => page.next,
      (page) => collected.push(...page.items),
    );

    expect(requested).toEqual([undefined, 'p2', 'p3']);
    expect(collected).toEqual([1, 2, 3, 4]);
    expect(maxInFlight).toBe(1);
  });

  it('fetches exactly one page when there is no next cursor', async () => {
    let calls = 0;
    await forEachPage(
      async () => { calls++; return { next: undefined as string | undefined }; },
      (page) => page.next,
      () => {},
    );
    expect(calls).toBe(1);
  });

  it('propagates a fetch error and stops paginating', async () => {
    let calls = 0;
    await expect(
      forEachPage(
        async (cursor) => {
          calls++;
          if (cursor === 'p2') throw new Error('page failed');
          return { next: 'p2' as string | undefined };
        },
        (page) => page.next,
        () => {},
      ),
    ).rejects.toThrow('page failed');
    expect(calls).toBe(2);
  });
});
