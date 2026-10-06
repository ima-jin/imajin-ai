/**
 * Small promise-flow helpers that make the *intent* of a multi-step async flow
 * explicit (typescript:S9382 — no `await` inside a loop body):
 *
 * - `forEachSequential` — one step at a time, in order, stopping at the first
 *   rejection. Use where order is the point (ledger writes, rate-limited
 *   provider calls, attestation emission).
 * - `mapWithConcurrency` — independent steps, at most `limit` in flight at
 *   once, results returned in input order. Use for independent reads.
 * - `forEachPage` — cursor pagination: each page's request depends on the
 *   previous page's cursor, so pages are inherently sequential.
 *
 * Behaviour is identical to the `for … of` + `await` loops they replace:
 * steps never overlap, order is preserved, and the first rejection propagates
 * and prevents every later step from starting.
 */

/** Run `fn` over `items` strictly one after another; the first rejection stops the chain. */
export function forEachSequential<T>(
  items: Iterable<T>,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let index = 0;
  let chain: Promise<void> = Promise.resolve();
  for (const item of items) {
    const i = index++;
    chain = chain.then(() => fn(item, i));
  }
  return chain;
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight (processed in
 * windows of `limit`). Results keep input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
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
 * Walk a cursor-paginated endpoint: fetch a page, hand it to `onPage`, and
 * follow `nextCursor` until it returns a falsy value. Pages are fetched
 * strictly one at a time — page N+1's request needs page N's cursor.
 */
export async function forEachPage<R>(
  fetchPage: (cursor: string | undefined) => Promise<R>,
  nextCursor: (page: R) => string | undefined,
  onPage: (page: R) => void,
  cursor?: string,
): Promise<void> {
  const page = await fetchPage(cursor);
  onPage(page);
  const next = nextCursor(page);
  if (next) await forEachPage(fetchPage, nextCursor, onPage, next);
}
