/**
 * Server-initiated WS liveness check (#2099).
 *
 * A gateway socket that crashes without a clean TCP close never fires `close`
 * — it just sits at `readyState === OPEN` forever from the server's point of
 * view, which is exactly what let `sendToDid` keep reporting `sent = true`
 * for a peer that was already gone (#2098's Candidate A; see
 * docs/warp-notification-chain.md). `ws.ping()` on an interval is the
 * standard fix: a socket that misses two consecutive pongs is presumed dead
 * and `terminate()`d immediately, rather than waiting on a `close` event
 * that will never come.
 *
 * Kept as a small, pure-ish module (like `also-registry.js` and
 * `notification-backlog.js`) so it is unit-testable with fake sockets and an
 * injected `releaseClaims`, independent of real timers or `ws-server.js`'s
 * own connection bookkeeping. `ws-server.js` wires this to `didSockets` /
 * `socketMeta` and its own dead-socket cleanup via the `onDead` callback
 * `sweep`/`start` take.
 */

const DEFAULT_INTERVAL_MS = 30_000;
/** Consecutive missed pongs before a socket is presumed dead. */
const DEFAULT_MISSED_LIMIT = 2;

/**
 * @param {object} [options]
 * @param {number} [options.intervalMs] Ping interval. Defaults to 30s.
 * @param {number} [options.missedLimit] Consecutive missed pongs before
 *   termination. Defaults to 2.
 * @param {(did: string) => Promise<void>|void} [options.releaseClaims]
 *   Called with a terminated socket's DID so its un-acked WS claims are
 *   released for replay on that DID's next reconnect (#2099). Never called
 *   for a socket with no authenticated DID yet (still mid auth handshake).
 * @param {(message: string) => void} [options.log]
 */
function createHeartbeat(options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const missedLimit = options.missedLimit ?? DEFAULT_MISSED_LIMIT;
  const releaseClaims = options.releaseClaims ?? (() => {});
  const log = options.log ?? (() => {});

  /** @type {Map<object, { isAlive: boolean, missed: number }>} */
  const state = new Map();

  /** Start tracking a newly connected socket. */
  function track(ws) {
    state.set(ws, { isAlive: true, missed: 0 });
  }

  /** Stop tracking a socket that closed on its own (normal `close` path). */
  function untrack(ws) {
    state.delete(ws);
  }

  /** Record a pong: the socket answered the most recent ping. */
  function markAlive(ws) {
    const entry = state.get(ws);
    if (!entry) return;
    entry.isAlive = true;
    entry.missed = 0;
  }

  /** Invoke `releaseClaims(did)`, tolerating a sync throw or a rejected promise. */
  function safeReleaseClaims(did) {
    if (!did) return;
    try {
      const result = releaseClaims(did);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log(`release claims failed for ${did}: ${err.message}`));
      }
    } catch (err) {
      log(`release claims threw for ${did}: ${err.message}`);
    }
  }

  /**
   * A socket missed too many pongs: stop tracking it, let the caller remove
   * it from its own indexes, release its DID's un-acked claims, then
   * actually terminate the connection — in that order, so "removed from
   * didSockets" and "claims released" are both true before the underlying
   * socket teardown even begins.
   */
  function terminateDead(ws, meta, onDead) {
    state.delete(ws);
    onDead(ws, meta);
    safeReleaseClaims(meta?.did);
    ws.terminate();
  }

  function sweepOne(ws, meta, onDead) {
    const entry = state.get(ws);
    if (!entry) return;

    if (entry.isAlive) {
      entry.missed = 0;
    } else {
      entry.missed += 1;
      if (entry.missed >= missedLimit) {
        terminateDead(ws, meta, onDead);
        return;
      }
    }

    entry.isAlive = false;
    ws.ping();
  }

  /**
   * One sweep tick over every currently tracked socket.
   * @param {Iterable<[object, object]>} sockets Entries of `[ws, meta]`,
   *   e.g. `socketMeta.entries()`.
   * @param {(ws: object, meta: object) => void} onDead Called for a socket
   *   this sweep decides to terminate, before `releaseClaims`/`terminate()`
   *   — callers use this to remove the socket from their own indexes
   *   (didSockets, socketMeta, register_also delegations, presence).
   */
  function sweep(sockets, onDead) {
    for (const [ws, meta] of sockets) {
      sweepOne(ws, meta, onDead);
    }
  }

  /**
   * Start the recurring sweep. `getSockets` is called fresh on every tick so
   * callers can hand over a live view (e.g. `() => socketMeta.entries()`)
   * rather than a snapshot that goes stale as connections come and go.
   * @returns {NodeJS.Timeout}
   */
  function start(getSockets, onDead) {
    return setInterval(() => sweep(getSockets(), onDead), intervalMs);
  }

  return { start, sweep, track, untrack, markAlive };
}

module.exports = { createHeartbeat, DEFAULT_INTERVAL_MS, DEFAULT_MISSED_LIMIT };
