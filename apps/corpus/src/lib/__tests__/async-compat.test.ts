import { describe, expect, it } from 'vitest';
import { settle, toAsyncIterable } from '../async-compat.js';

describe('settle', () => {
  it('resolves with the return value', async () => {
    await expect(settle(() => 42)).resolves.toBe(42);
  });

  it('turns a synchronous throw into a rejection instead of throwing', async () => {
    const failure = new Error('sync boom');
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = settle(() => {
        throw failure;
      });
    }).not.toThrow();
    await expect(promise).rejects.toBe(failure);
  });
});

describe('toAsyncIterable', () => {
  it('yields every item in order', async () => {
    const seen: number[] = [];
    for await (const item of toAsyncIterable([1, 2, 3])) seen.push(item);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('is lazy: the source does not run until iteration starts', async () => {
    let started = false;
    function* source() {
      started = true;
      yield 1;
    }
    const iterable = toAsyncIterable(source());
    expect(started).toBe(false);
    const iterator = iterable[Symbol.asyncIterator]();
    expect(started).toBe(false);
    await iterator.next();
    expect(started).toBe(true);
  });

  it('surfaces a synchronous throw from the source as a rejection', async () => {
    function* source(): Generator<number> {
      yield 1;
      throw new Error('walk failed');
    }
    const seen: number[] = [];
    const run = async () => {
      for await (const item of toAsyncIterable(source())) seen.push(item);
    };
    await expect(run()).rejects.toThrow('walk failed');
    expect(seen).toEqual([1]);
  });

  it('closes the source when the consumer breaks early', async () => {
    let closed = false;
    function* source() {
      try {
        yield 1;
        yield 2;
      } finally {
        closed = true;
      }
    }
    for await (const item of toAsyncIterable(source())) {
      if (item === 1) break;
    }
    expect(closed).toBe(true);
  });

  it('return() resolves done for sources without a return method', async () => {
    const source: Iterable<number> = {
      [Symbol.iterator]: () => ({ next: () => ({ done: true, value: undefined }) }),
    };
    const iterator = toAsyncIterable(source)[Symbol.asyncIterator]();
    await expect(iterator.return?.('x')).resolves.toEqual({ done: true, value: 'x' });
  });
});
