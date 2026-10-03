/**
 * Live WebSocket connection state for DIDs (#2407, RFC-31 Phase 1).
 *
 * `ws-server.js` is the only place that knows which DIDs hold an open socket,
 * and it runs beside Next rather than inside it, so a route asks it over the
 * same internal-key HTTP seam `ws-push.ts` uses for `did-push`. The lookup is
 * read-only — it never sends to, or changes, a socket.
 *
 * Three states, not two. `unknown` means the answer could not be obtained
 * (key unset, ws-server unreachable, a non-2xx reply). It must never be
 * reported as `disconnected`: "we could not check" and "nothing is listening"
 * call for different reactions from a router.
 */
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export type DidConnectionState = 'connected' | 'disconnected' | 'unknown';

/** Must match MAX_DIDS_PER_LOOKUP in `src/lib/ws/did-connections.js`. */
const MAX_DIDS_PER_REQUEST = 50;

const DID_CONNECTIONS_PATH = '/chat/api/internal/did-connections';

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Ask ws-server which of `dids` are connected. Resolves null on any failure. */
async function fetchConnected(dids: string[], internalKey: string): Promise<Set<string> | null> {
  const port = process.env.WS_PORT || process.env.PORT || '3000';
  try {
    const res = await fetch(`http://localhost:${port}${DID_CONNECTIONS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': internalKey },
      body: JSON.stringify({ dids }),
      cache: 'no-store',
    });
    if (!res.ok) {
      log.warn({ status: res.status }, '[did-connections] ws-server lookup failed');
      return null;
    }
    const data = (await res.json()) as { connected?: unknown };
    if (!Array.isArray(data.connected)) return null;
    return new Set(data.connected.filter((did): did is string => typeof did === 'string'));
  } catch (err) {
    log.warn({ err: String(err) }, '[did-connections] ws-server lookup errored');
    return null;
  }
}

/**
 * Connection state for each DID in `dids` (deduplicated). Never throws.
 */
export async function getDidConnectionStates(dids: readonly string[]): Promise<Map<string, DidConnectionState>> {
  const states = new Map<string, DidConnectionState>();
  const unique = [...new Set(dids)];
  if (unique.length === 0) return states;

  const internalKey = process.env.AUTH_INTERNAL_API_KEY;
  if (!internalKey) {
    log.warn({ count: unique.length }, '[did-connections] AUTH_INTERNAL_API_KEY not set — connection state unknown');
    for (const did of unique) states.set(did, 'unknown');
    return states;
  }

  for (const batch of chunk(unique, MAX_DIDS_PER_REQUEST)) {
    const connected = await fetchConnected(batch, internalKey);
    for (const did of batch) {
      if (connected === null) {
        states.set(did, 'unknown');
      } else {
        states.set(did, connected.has(did) ? 'connected' : 'disconnected');
      }
    }
  }
  return states;
}
