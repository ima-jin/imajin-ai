/**
 * Live-connection lookup for DIDs (#2407, RFC-31 Phase 1).
 *
 * The kernel addresses an agent by DID, never by gateway. Whether that DID is
 * reachable right now is a fact only ws-server.js holds (its `didSockets`
 * index), so the Next routes ask for it through one internal HTTP route —
 * the same shape as `did-push`. This module is the pure part of that route so
 * it can be unit-tested without a socket server.
 *
 * Only a DID's OWN sockets count. `register_also` delegate sockets are held in
 * a separate registry (#1653) and deliberately never make a principal look
 * "connected": an agent being online must not read as its owner being online,
 * and a delegate registration must not read as the principal's own harness.
 *
 * Plain CJS because ws-server.js is loaded by `node server.js`, outside the
 * Next build.
 */

/** Cap on DIDs per lookup — a principal serves a handful of agents, not thousands. */
const MAX_DIDS_PER_LOOKUP = 50;

/** ws `readyState` for an open socket (WebSocket.OPEN). */
const WS_OPEN = 1;

/**
 * Validate the request body of a did-connections lookup.
 * @param {unknown} body
 * @returns {{ ok: true, dids: string[] } | { ok: false }}
 */
function parseDidConnectionsBody(body) {
  const dids = body && typeof body === 'object' ? body.dids : undefined;
  if (!Array.isArray(dids) || dids.length === 0 || dids.length > MAX_DIDS_PER_LOOKUP) {
    return { ok: false };
  }
  if (!dids.every((did) => typeof did === 'string' && did.length > 0)) {
    return { ok: false };
  }
  return { ok: true, dids: [...new Set(dids)] };
}

/**
 * @param {Map<string, Set<{ readyState: number }>>} didSockets own-socket index
 * @param {string[]} dids
 * @returns {string[]} the subset of `dids` with at least one open own socket
 */
function connectedDids(didSockets, dids) {
  return dids.filter((did) => {
    const sockets = didSockets.get(did);
    if (!sockets) return false;
    for (const ws of sockets) {
      if (ws.readyState === WS_OPEN) return true;
    }
    return false;
  });
}

/** Internal route the kernel's Next routes call; same family as `did-push`. */
const DID_CONNECTIONS_PATH = '/chat/api/internal/did-connections';

/** A lookup body is a short DID list; anything bigger is not a legitimate caller. */
const MAX_BODY_BYTES = 16 * 1024;

function reply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * Answer `POST /chat/api/internal/did-connections` with `{ connected: string[] }`.
 *
 * Guarded by the same `x-internal-key` secret as every other internal ws route
 * (AUTH_INTERNAL_API_KEY); an unset key refuses outright rather than matching
 * an absent header. Read-only: nothing here sends to, or alters, a socket.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Map<string, Set<{ readyState: number }>>} didSockets own-socket index
 * @param {string | undefined} internalKey expected secret
 */
function handleDidConnectionsRequest(req, res, didSockets, internalKey) {
  const provided = req.headers['x-internal-key'];
  if (!internalKey || provided !== internalKey) {
    reply(res, 401, { error: 'Unauthorized' });
    return;
  }

  let body = '';
  let tooLarge = false;
  req.on('data', (chunk) => {
    if (tooLarge) return;
    body += chunk;
    if (body.length > MAX_BODY_BYTES) tooLarge = true;
  });
  req.on('end', () => {
    if (tooLarge) {
      reply(res, 413, { error: 'Payload too large' });
      return;
    }
    let parsed;
    try {
      parsed = parseDidConnectionsBody(JSON.parse(body));
    } catch {
      parsed = { ok: false };
    }
    if (!parsed.ok) {
      reply(res, 400, { error: 'Bad request' });
      return;
    }
    reply(res, 200, { connected: connectedDids(didSockets, parsed.dids) });
  });
}

module.exports = {
  parseDidConnectionsBody,
  connectedDids,
  handleDidConnectionsRequest,
  DID_CONNECTIONS_PATH,
  MAX_DIDS_PER_LOOKUP,
  MAX_BODY_BYTES,
};
