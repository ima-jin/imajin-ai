/**
 * `register_also` delegation registry (#1653).
 *
 * An agent connects to the WS as itself and, when it acts on behalf of a
 * principal (`actAs`, #1545), asks to also receive that principal's frames:
 *
 *   { type: 'register_also',   did: '<principal-DID>' }
 *   { type: 'unregister_also', did: '<principal-DID>' }
 *
 * Delegate sockets are held in their own map rather than being folded into
 * ws-server's `didSockets`. `didSockets` is not only a delivery index: its per-DID
 * set size is what decides "this DID just came online / just went offline". Adding
 * an agent's socket under the principal's DID would pin the principal online for as
 * long as the agent stayed connected, and would suppress the principal's own
 * last_seen update on disconnect. Keeping the two indexes apart means delegation
 * changes fan-out and nothing else — `recipientsFor` unions them at send time.
 *
 * This module is plain CJS because ws-server.js is loaded by `node server.js`,
 * outside the Next build.
 */

/** Cap on extra DIDs one socket may receive frames for. */
const MAX_ALSO_DIDS = 5;

function errorFrame(message) {
  return { type: 'error', message };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * @param {object} [options]
 * @param {number} [options.maxAlsoDids] Cap on also-registrations per socket.
 * @param {(agentDid: string, principalDid: string) => Promise<boolean>} options.verifyDelegation
 *   Authorization check. Must resolve `true` only for an active delegation.
 * @param {(message: string) => void} [options.log]
 */
function createAlsoRegistry(options = {}) {
  const maxAlsoDids = options.maxAlsoDids ?? MAX_ALSO_DIDS;
  const { verifyDelegation } = options;
  const log = options.log ?? (() => {});

  /** principal DID -> delegate sockets. @type {Map<string, Set<object>>} */
  const alsoDidSockets = new Map();
  /** socket -> DIDs with a verification in flight. @type {Map<object, Set<string>>} */
  const inFlight = new Map();
  /** Sockets whose close already ran, so a late verification cannot resurrect them. */
  const closedSockets = new WeakSet();

  function attach(did, ws) {
    let sockets = alsoDidSockets.get(did);
    if (!sockets) {
      sockets = new Set();
      alsoDidSockets.set(did, sockets);
    }
    sockets.add(ws);
  }

  function detach(did, ws) {
    const sockets = alsoDidSockets.get(did);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) alsoDidSockets.delete(did);
  }

  function reserve(ws, did) {
    let reserved = inFlight.get(ws);
    if (!reserved) {
      reserved = new Set();
      inFlight.set(ws, reserved);
    }
    reserved.add(did);
  }

  function release(ws, did) {
    const reserved = inFlight.get(ws);
    if (!reserved) return;
    reserved.delete(did);
    if (reserved.size === 0) inFlight.delete(ws);
  }

  /**
   * Reject a `register_also` before the (awaited) authorization check, or return
   * null when the request should proceed to verification.
   */
  function rejectRegister(ws, meta, alsoDid) {
    if (!isNonEmptyString(alsoDid)) return errorFrame('register_also requires a DID');
    if (!meta.did) return errorFrame('Not authenticated');
    if (inFlight.get(ws)?.has(alsoDid)) {
      return errorFrame('register_also already in flight for this DID');
    }
    // In-flight reservations count against the cap. Two frames arriving in one
    // TCP read both run before either await settles, so the committed set alone
    // is not an honest count of what this socket has claimed.
    const claimed = meta.alsoDids.size + (inFlight.get(ws)?.size ?? 0);
    if (claimed >= maxAlsoDids) return errorFrame('Too many register_also registrations');
    return null;
  }

  /**
   * @returns {Promise<object|null>} Frame to send back, or null when the socket
   *   went away mid-verification and there is nobody left to answer.
   */
  async function register(ws, meta, alsoDid) {
    // The socket's own DID, and a DID it already holds, are both already
    // satisfied. Ack rather than staying silent so a client that waits on the
    // round trip is never left hanging.
    if (isNonEmptyString(alsoDid) && (alsoDid === meta.did || meta.alsoDids.has(alsoDid))) {
      return { type: 'registered_also', did: alsoDid };
    }

    const rejection = rejectRegister(ws, meta, alsoDid);
    if (rejection) return rejection;

    reserve(ws, alsoDid);
    let allowed = false;
    try {
      allowed = (await verifyDelegation(meta.did, alsoDid)) === true;
    } catch (err) {
      log(`register_also verification threw for ${meta.did} -> ${alsoDid}: ${err.message}`);
    } finally {
      release(ws, alsoDid);
    }

    if (closedSockets.has(ws)) {
      // Closed while the check was out. Registering now would leak the socket
      // into the map: its close handler has already run.
      log(`register_also raced a close for ${meta.did} -> ${alsoDid}`);
      return null;
    }

    if (!allowed) {
      log(`${meta.did} denied register_also for ${alsoDid} (no delegation)`);
      return errorFrame('Not authorized to register for this DID');
    }

    meta.alsoDids.add(alsoDid);
    attach(alsoDid, ws);
    log(`${meta.did} registered also for ${alsoDid} (delegation verified)`);
    return { type: 'registered_also', did: alsoDid };
  }

  /**
   * Drop a delegation without dropping the connection — an agent whose `actAs`
   * target changes mid-session would otherwise keep receiving the old
   * principal's frames until it reconnected.
   */
  function unregister(ws, meta, alsoDid) {
    if (!isNonEmptyString(alsoDid)) return errorFrame('unregister_also requires a DID');
    meta.alsoDids.delete(alsoDid);
    detach(alsoDid, ws);
    return { type: 'unregistered_also', did: alsoDid };
  }

  /**
   * Route a `register_also` / `unregister_also` frame.
   * @returns {Promise<object|null>} Frame to send back, or null for both an
   *   unrelated message type and a socket that closed mid-verification.
   */
  async function handle(ws, meta, msg) {
    if (msg.type === 'register_also') return register(ws, meta, msg.did);
    if (msg.type === 'unregister_also') return unregister(ws, meta, msg.did);
    return null;
  }

  /** Release every delegation held by a socket. Called from the close handler. */
  function cleanup(ws, meta) {
    closedSockets.add(ws);
    inFlight.delete(ws);
    const dids = meta?.alsoDids;
    if (!dids) return;
    for (const did of dids) detach(did, ws);
    dids.clear();
  }

  /**
   * Every socket that should receive a frame addressed to `did`: the DID's own
   * sockets plus any delegates registered for it.
   * @returns {Set<object>|undefined} undefined when nobody is listening.
   */
  function recipientsFor(did, ownSockets) {
    const delegates = alsoDidSockets.get(did);
    if (!delegates || delegates.size === 0) return ownSockets;
    if (!ownSockets || ownSockets.size === 0) return delegates;
    return new Set([...ownSockets, ...delegates]);
  }

  return { handle, cleanup, recipientsFor, maxAlsoDids };
}

module.exports = { createAlsoRegistry, MAX_ALSO_DIDS };
