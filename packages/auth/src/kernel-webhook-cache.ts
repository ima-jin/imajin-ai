/** One entry per store/kernel, never one entry per attacker-controlled kid. */
interface Entry<T> {
  value?: T;
  fetchedAt: number;
  attemptedAt: number;
  failure?: unknown;
  pending?: Promise<T>;
}
const CACHE = Symbol.for('@imajin/auth/kernel-webhook/discovery-cache/v1');
type Registry = WeakMap<object, Map<string, Entry<unknown>>>;
const registry = globalThis as typeof globalThis & { [CACHE]?: Registry };
const stores = registry[CACHE] ??= new WeakMap();
export class KernelDiscoveryCacheError extends Error {}

export async function cachedKernelDiscovery<T>(input: {
  store: object;
  namespace: string;
  ttl: number;
  now: () => number;
  refresh: () => Promise<T>;
  hasKey: (value: T) => boolean;
}): Promise<T> {
  if (input.ttl === 0) return input.refresh();
  let namespaces = stores.get(input.store);
  if (!namespaces) {
    namespaces = new Map();
    stores.set(input.store, namespaces);
  }
  let entry = namespaces.get(input.namespace) as Entry<T> | undefined;
  if (!entry) {
    // Never evict rate-limit evidence under namespace pressure.
    if (namespaces.size >= 64) throw new KernelDiscoveryCacheError('Kernel discovery namespace capacity exhausted');
    entry = { fetchedAt: -Infinity, attemptedAt: -Infinity };
    namespaces.set(input.namespace, entry as Entry<unknown>);
  }
  const now = input.now();
  const fresh = entry.value !== undefined && now >= entry.fetchedAt && now - entry.fetchedAt < input.ttl;
  if (fresh && input.hasKey(entry.value as T)) return entry.value as T;
  if (entry.pending) return entry.pending;
  if (now - entry.attemptedAt < 5_000) {
    if (fresh) return entry.value as T;
    throw entry.failure ?? new KernelDiscoveryCacheError('Kernel discovery refresh rate limited');
  }
  entry.attemptedAt = now;
  const target = entry;
  target.pending = input.refresh().then((value) => {
    target.value = value;
    target.fetchedAt = input.now();
    target.failure = undefined;
    return value;
  }).catch((error: unknown) => {
    target.failure = error;
    throw error;
  }).finally(() => { target.pending = undefined; });
  return target.pending;
}
