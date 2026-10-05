/**
 * Maps `items` through `fn` strictly one at a time, in order, resolving to the
 * results in input order. The next call starts only after the previous one has
 * resolved; the first rejection stops the chain (later items never start).
 *
 * For migrations, seeds and other scripts where order is the point. Independent
 * work should use `Promise.all` instead.
 *
 * @template T, R
 * @param {Iterable<T>} items
 * @param {(item: T, index: number) => Promise<R> | R} fn
 * @returns {Promise<R[]>}
 */
export function mapSequentially(items, fn) {
  return Array.from(items).reduce(
    async (previous, item, index) => {
      const results = await previous;
      results.push(await fn(item, index));
      return results;
    },
    Promise.resolve(/** @type {R[]} */ ([])),
  );
}
