/**
 * Maps `items` through `fn` strictly one at a time, in order, resolving to the
 * results in input order. The next call starts only after the previous one has
 * resolved; the first rejection stops the chain (later items never start).
 *
 * Use where order or load is intentional (batched calls to a rate-limited
 * service, cursor-dependent pagination). For independent work use `Promise.all`.
 */
export function mapSequentially<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return items.reduce<Promise<R[]>>(async (previous, item, index) => {
    const results = await previous;
    results.push(await fn(item, index));
    return results;
  }, Promise.resolve([]));
}
