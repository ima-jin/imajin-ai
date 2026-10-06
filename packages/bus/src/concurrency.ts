/**
 * Small promise-flow helpers (internal to `@imajin/bus`, not exported from the
 * package index) that make the *intent* of a multi-step async flow explicit:
 *
 * - `forEachSequential` — one step at a time, in order, stopping at the first
 *   rejection. Use where order is the point (reactor chains, ledger-style
 *   writes, ranked delivery).
 * - `mapWithConcurrency` — independent steps, at most `limit` in flight at
 *   once, results returned in input order. Use for independent reads.
 */

/** Run `fn` over `items` strictly one after another; the first rejection stops the chain. */
export function forEachSequential<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  return items.reduce<Promise<void>>(
    (chain, item, index) => chain.then(() => fn(item, index)),
    Promise.resolve()
  );
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight (processed in
 * windows of `limit`). Results keep input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  const windowStarts: number[] = [];
  for (let start = 0; start < items.length; start += size) windowStarts.push(start);

  const results: R[] = [];
  await forEachSequential(windowStarts, async (start) => {
    const window = items.slice(start, start + size);
    results.push(...(await Promise.all(window.map((item, offset) => fn(item, start + offset)))));
  });
  return results;
}

/**
 * Run a synchronous body behind a Promise contract: the return value resolves
 * and a synchronous throw becomes a rejection, so a caller's `.catch` still
 * fires exactly as it would for an `async` function.
 */
export function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
