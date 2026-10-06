/**
 * Runs a synchronous `fn` and returns its result as a Promise. A synchronous
 * throw becomes a rejected promise, exactly as it would inside an `async`
 * function, so a caller's `.catch` / `await` try-block still sees it.
 *
 * For interface methods that must return a Promise but do no asynchronous work
 * (an `async` function without `await` is a Sonar S7503 finding).
 */
export function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Adapts a (lazy) synchronous iterable to an `AsyncIterable`. Nothing runs
 * until the first `next()`, a synchronous throw from the source surfaces as a
 * rejection of that `next()`, and `return()` closes the source so an early
 * `break` out of `for await` still runs the source's `finally` blocks.
 */
export function toAsyncIterable<T>(iterable: Iterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = iterable[Symbol.iterator]();
      return {
        next: () => settle(() => iterator.next()),
        return: (value?: unknown) => settle(() => iterator.return?.(value) ?? { done: true as const, value }),
      };
    },
  };
}
