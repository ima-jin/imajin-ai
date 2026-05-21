import { describe, it, expect } from 'vitest';
import { InMemoryFieldLock } from '../src/lock.js';

describe('InMemoryFieldLock', () => {
    it('allows a single acquire per field', async () => {
        const lock = new InMemoryFieldLock();
        const release = await lock.acquire('field-a');
        expect(typeof release).toBe('function');
        await release();
    });

    it('serializes concurrent acquires for the same field', async () => {
        const lock = new InMemoryFieldLock();
        const order: number[] = [];

        const r1 = await lock.acquire('x');
        const p2 = lock.acquire('x').then(async (release) => {
            order.push(2);
            await release();
        });
        const p3 = lock.acquire('x').then(async (release) => {
            order.push(3);
            await release();
        });

        // p2 and p3 should be waiting
        expect(order).toEqual([]);

        order.push(1);
        await r1();

        await p2;
        await p3;

        expect(order).toEqual([1, 2, 3]);
    });

    it('allows concurrent acquires for different fields', async () => {
        const lock = new InMemoryFieldLock();
        const order: number[] = [];

        const r1 = await lock.acquire('a');
        const p2 = lock.acquire('b').then(async (release) => {
            order.push(2);
            await release();
        });

        // p2 should proceed immediately because field 'b' is not locked
        await p2;
        expect(order).toEqual([2]);

        await r1();
    });

    it('releases correctly after multiple queued acquires', async () => {
        const lock = new InMemoryFieldLock();
        const results: string[] = [];

        async function worker(id: string) {
            const release = await lock.acquire('shared');
            results.push(id);
            await release();
        }

        const w1 = worker('a');
        const w2 = worker('b');
        const w3 = worker('c');

        await w1;
        await w2;
        await w3;

        expect(results).toEqual(['a', 'b', 'c']);
    });
});
