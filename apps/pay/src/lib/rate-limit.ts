/**
 * Simple sliding-window in-memory rate limiter.
 * Safe for single-process Next.js. Per-worker in multi-worker setups (acceptable).
 */

interface RateLimitEntry {
  timestamps: number[];
  lastSeen: number;
}

const store = new Map<string, RateLimitEntry>();
let lastGlobalCleanup = Date.now();

function pruneStore(now: number) {
  if (now - lastGlobalCleanup < 60_000) return;
  for (const [key, entry] of store) {
    if (now - entry.lastSeen > 120_000) {
      store.delete(key);
    }
  }
  lastGlobalCleanup = now;
}

export function rateLimit(
  ip: string,
  limit: number,
  windowMs: number
): { limited: boolean; retryAfter: number } {
  const now = Date.now();
  pruneStore(now);

  const windowStart = now - windowMs;
  const entry = store.get(ip) ?? { timestamps: [], lastSeen: now };

  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  entry.lastSeen = now;

  if (entry.timestamps.length >= limit) {
    const oldest = entry.timestamps[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    store.set(ip, entry);
    return { limited: true, retryAfter: Math.max(1, retryAfter) };
  }

  entry.timestamps.push(now);
  store.set(ip, entry);
  return { limited: false, retryAfter: 0 };
}

export function getClientIP(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return '127.0.0.1';
}
