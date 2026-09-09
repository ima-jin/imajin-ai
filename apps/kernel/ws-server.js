const { WebSocketServer } = require('ws');
const { createAlsoRegistry } = require('./src/lib/ws/also-registry');
const { createNotificationBacklogReplayer } = require('./src/lib/ws/notification-backlog');
const { createHeartbeat } = require('./src/lib/ws/heartbeat');

/** @type {Map<import('ws').WebSocket, { did: string, alsoDids: Set<string>, subscriptions: Set<string> }>} */
const socketMeta = new Map();
/**
 * Sockets a DID owns. Presence is derived from these set sizes (1 => online,
 * 0 => offline), so delegated `register_also` sockets deliberately live in the
 * separate registry below rather than here.
 * @type {Map<string, Set<import('ws').WebSocket>>}
 */
const didSockets = new Map();
/** @type {Map<string, Map<string, { did: string, name: string, timeout: NodeJS.Timeout }>>} */
const typingStatus = new Map(); // conversationId -> Map<did, {did, name, timeout}>

let wss;

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...rest] = c.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

function getSessionCookieName() {
  const env = process.env.IMAJIN_ENV === 'dev' || process.env.NODE_ENV === 'development'
    ? 'dev' : 'prod';
  return env === 'dev' ? 'imajin_session_dev' : 'imajin_session';
}

async function authenticateWithCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  const cookieName = getSessionCookieName();
  const token = cookies[cookieName];
  if (!token) return null;
  return authenticateToken(cookieName, token);
}

async function authenticateToken(cookieName, token) {
  const port = process.env.PORT || '3000';
  try {
    const res = await fetch(`http://localhost:${port}/auth/api/session`, {
      headers: { Cookie: `${cookieName}=${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || data.identity?.did || null;
  } catch (err) {
    console.error('[WS] Auth error:', err.message);
    return null;
  }
}

/**
 * Validate a short-lived WS token via the local API endpoint
 */
async function authenticateWsToken(token) {
  const port = process.env.PORT || '3000';
  try {
    const res = await fetch(`http://localhost:${port}/chat/api/ws-token/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || null;
  } catch (err) {
    console.error('[WS] Token auth error:', err.message);
    return null;
  }
}

/**
 * Update last_seen_at for a user going offline
 */
async function updateLastSeen(did) {
  try {
    const port = process.env.PORT || '3000';
    await fetch(`http://localhost:${port}/profile/api/presence/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ did, lastSeenAt: new Date().toISOString() }),
    });
  } catch (err) {
    console.error('[WS] Failed to update last_seen:', err.message);
  }
}

/**
 * Handle typing indicator
 */
function handleTyping(conversationId, did, name) {
  if (!typingStatus.has(conversationId)) {
    typingStatus.set(conversationId, new Map());
  }
  const conversationTyping = typingStatus.get(conversationId);

  // Clear existing timeout if any
  if (conversationTyping.has(did)) {
    clearTimeout(conversationTyping.get(did).timeout);
  }

  // Set new timeout for auto-expiry (5 seconds)
  const timeout = setTimeout(() => {
    handleStopTyping(conversationId, did);
  }, 5000);

  conversationTyping.set(did, { did, name, timeout });

  // Broadcast to conversation participants
  broadcastToConversation(conversationId, {
    type: 'user_typing',
    conversationId,
    did,
    name,
  }, did); // Exclude sender
}

/**
 * Handle stop typing
 */
function handleStopTyping(conversationId, did) {
  if (!typingStatus.has(conversationId)) return;

  const conversationTyping = typingStatus.get(conversationId);
  if (!conversationTyping.has(did)) return;

  // Clear timeout
  const entry = conversationTyping.get(did);
  clearTimeout(entry.timeout);
  conversationTyping.delete(did);

  // Clean up empty map
  if (conversationTyping.size === 0) {
    typingStatus.delete(conversationId);
  }

  // Broadcast to conversation participants
  broadcastToConversation(conversationId, {
    type: 'user_stop_typing',
    conversationId,
    did,
  }, did); // Exclude sender
}

/**
 * Broadcast to all participants in a conversation
 */
function broadcastToConversation(conversationId, payload, excludeDid = null) {
  if (!wss) return;
  const payloadStr = JSON.stringify(payload);
  for (const [ws, meta] of socketMeta) {
    if (meta.subscriptions.has(conversationId) &&
        ws.readyState === 1 &&
        (!excludeDid || meta.did !== excludeDid)) {
      ws.send(payloadStr);
    }
  }
}

/**
 * Broadcast presence change to relevant conversations
 */
async function broadcastPresenceChange(did, isOnline) {
  try {
    const port = process.env.PORT || '3000';
    const res = await fetch(`http://localhost:${port}/chat/api/participants/${encodeURIComponent(did)}/conversations`);
    if (!res.ok) return;
    const data = await res.json();
    const conversationIds = data.conversationIds || [];

    const payload = {
      type: 'user_presence',
      did,
      online: isOnline,
      lastSeen: isOnline ? null : new Date().toISOString(),
    };

    // Broadcast to each conversation
    conversationIds.forEach(convId => {
      broadcastToConversation(convId, payload);
    });
  } catch (err) {
    console.error('[WS] Failed to broadcast presence:', err.message);
  }
}

/**
 * Verify that agentDid has an active agent delegation for principalDid.
 * Checks identity_members via an internal HTTP call (same pattern as
 * authenticateWithCookie and authenticateWsToken — ws-server.js is plain
 * CJS outside Next, so it calls back into the app routes).
 *
 * Returns true only when an active (not revoked) role='agent' membership
 * exists. Never throws.
 */
async function verifyAgentDelegation(agentDid, principalDid) {
  const port = process.env.PORT || '3000';
  const key = process.env.AUTH_INTERNAL_API_KEY;
  if (!key) {
    console.error('[WS] AUTH_INTERNAL_API_KEY not set, denying register_also');
    return false;
  }
  try {
    const res = await fetch(`http://localhost:${port}/auth/api/internal/verify-delegation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': key,
      },
      body: JSON.stringify({ agentDid, principalDid }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.allowed === true;
  } catch (err) {
    console.error('[WS] Delegation verify error:', err.message);
    return false;
  }
}

/**
 * Delegated `register_also` fan-out (#1653). Held apart from `didSockets` so a
 * delegate socket never masquerades as the principal for presence purposes.
 */
const alsoRegistry = createAlsoRegistry({
  verifyDelegation: verifyAgentDelegation,
  log: (message) => console.log('[WS]', message),
});

/**
 * Fetch `did`'s undelivered notification backlog from the kernel (#2044).
 * Each returned frame has already been atomically claimed server-side
 * (`getNotificationBacklog`'s `delivered_at IS NULL` guard), so ws-server.js
 * only has to send them — it never touches the database directly, the same
 * reasoning as `verifyAgentDelegation` above.
 */
async function fetchNotificationBacklog(did) {
  const port = process.env.PORT || '3000';
  const key = process.env.AUTH_INTERNAL_API_KEY;
  if (!key) return { frames: [], truncated: false };
  const res = await fetch(`http://localhost:${port}/notify/api/internal/backlog`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-key': key,
    },
    body: JSON.stringify({ did }),
  });
  if (!res.ok) return { frames: [], truncated: false };
  return res.json();
}

/**
 * Replays a reconnecting DID's undelivered notification backlog (#2044).
 * See src/lib/notify/backlog.ts for why replay and a live push racing the
 * same row can never both deliver it.
 */
const notificationBacklog = createNotificationBacklogReplayer({
  fetchBacklog: fetchNotificationBacklog,
  log: (message) => console.log('[WS]', message),
});

/**
 * Handle a deferred 'auth' message (WS token supplied after connecting
 * unauthenticated). On success, promotes the socket the same way the
 * cookie-auth path in setupWebSocket's upgrade handler does.
 */
async function handleAuthMessage(ws, meta, msg) {
  const authedDid = await authenticateWsToken(msg.token);
  if (!authedDid) {
    ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }));
    ws.close(4001, 'Authentication failed');
    return;
  }
  meta.did = authedDid;
  meta.authenticated = true;
  if (!didSockets.has(authedDid)) didSockets.set(authedDid, new Set());
  didSockets.get(authedDid).add(ws);
  ws.send(JSON.stringify({ type: 'connected' }));
  // Fire-and-forget, same as the cookie-auth path above (#2044).
  notificationBacklog.replay(ws, authedDid);
  if (didSockets.get(authedDid).size === 1) {
    broadcastPresenceChange(authedDid, true);
  }
  console.log('[WS] Deferred auth succeeded for:', authedDid);
}

/**
 * Agent delegation: also receive notifications for this DID (#1545/#1653).
 * The registry verifies the delegation before it registers anything.
 */
async function handleAlsoRegistryMessage(ws, meta, msg) {
  const frame = await alsoRegistry.handle(ws, meta, msg);
  if (frame && ws.readyState === 1) ws.send(JSON.stringify(frame));
}

function handleSubscribeMessage(meta, msg) {
  if (msg.conversationId) meta.subscriptions.add(msg.conversationId);
  if (msg.did) meta.subscriptions.add(msg.did);
}

function handleTypingMessage(meta, msg) {
  const channel = msg.did || msg.conversationId;
  if (channel) handleTyping(channel, meta.did, msg.name || null);
}

function handleStopTypingMessage(meta, msg) {
  const channel = msg.did || msg.conversationId;
  if (channel) handleStopTyping(channel, meta.did);
}

/**
 * Release `did`'s un-acked WS claims (#2099). Called by the heartbeat the
 * moment it terminates a socket that missed too many pongs, so a fast
 * reconnect does not have to wait out the 30s ack timeout before its
 * backlog replay re-offers a notification that was sent to the socket that
 * just died. Fire-and-forget by contract — a failed release just means
 * those rows wait out their own ack timeout instead, same reasoning as
 * `fetchNotificationBacklog` degrading to an empty backlog on failure.
 */
async function releaseWsClaims(did) {
  const port = process.env.PORT || '3000';
  const key = process.env.AUTH_INTERNAL_API_KEY;
  if (!key) return;
  try {
    await fetch(`http://localhost:${port}/notify/api/internal/release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': key,
      },
      body: JSON.stringify({ did }),
    });
  } catch (err) {
    console.error('[WS] Notification WS claim release failed:', err.message);
  }
}

/**
 * Forward the plugin's `{ type: 'notification_ack', id }` frame (#2099) to
 * the kernel — the only place `delivered_at` is ever set. `did` is always
 * the acking socket's own authenticated DID, never anything read out of
 * the frame itself, so `ackNotificationDelivery` can scope its UPDATE to
 * it (PR #2101 review: a socket must not be able to ack an arbitrary id
 * belonging to a different DID). Never throws: an ack that fails to land
 * is simply retried by the plugin's own retry/dedup logic, or the row
 * eventually times out and gets re-offered on the next reconnect either way.
 */
async function ackNotification(id, did) {
  const port = process.env.PORT || '3000';
  const key = process.env.AUTH_INTERNAL_API_KEY;
  if (!key) return;
  try {
    await fetch(`http://localhost:${port}/notify/api/internal/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': key,
      },
      body: JSON.stringify({ id, did }),
    });
  } catch (err) {
    console.error('[WS] Notification ack failed:', err.message);
  }
}

/**
 * Handle an inbound `{ type: 'notification_ack', id }` frame (#2099).
 * Binds the ack to `meta.did` -- the socket's own authenticated identity,
 * established at connection/auth time, never a value the frame itself
 * could spoof (#2101 review). A socket with no authenticated DID never
 * reaches here (the message dispatcher already rejects it), but the guard
 * stays as defense in depth.
 */
function handleNotificationAck(meta, msg) {
  if (typeof msg.id !== 'string' || !msg.id) return;
  if (!meta.did) return;
  ackNotification(msg.id, meta.did);
}

/**
 * Route one parsed WS message to its handler. Deferred auth is checked first
 * (it's the only message type allowed before `meta.authenticated`); every
 * other type is rejected until the socket has authenticated.
 */
async function dispatchMessage(ws, meta, msg) {
  if (msg.type === 'auth' && msg.token && !meta.authenticated) {
    await handleAuthMessage(ws, meta, msg);
    return;
  }

  if (!meta.authenticated) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated. Send auth message first.' }));
    return;
  }

  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    case 'register_also':
    case 'unregister_also':
      await handleAlsoRegistryMessage(ws, meta, msg);
      break;
    case 'subscribe':
      handleSubscribeMessage(meta, msg);
      break;
    case 'typing':
      handleTypingMessage(meta, msg);
      break;
    case 'stop_typing':
      handleStopTypingMessage(meta, msg);
      break;
    case 'notification_ack':
      // Protocol contract with the plugin (#2099): the only trigger for
      // `delivered_at`. Fire-and-forget — nothing useful to report back
      // over this socket either way, and a dropped ack just leaves the
      // row to time out and get re-offered on the next reconnect.
      handleNotificationAck(meta, msg);
      break;
  }
}

/**
 * Server-initiated liveness check (#2099): a dead gateway socket that never
 * fires `close` (a hard crash rather than a clean disconnect) would
 * otherwise sit in `didSockets` forever, letting `sendToDid` keep reporting
 * `sent = true` for a peer that is already gone. See src/lib/ws/heartbeat.js.
 */
const heartbeat = createHeartbeat({
  releaseClaims: releaseWsClaims,
  log: (message) => console.log('[WS]', message),
});

/**
 * Sockets already cleaned up, so a redundant event for the same socket
 * (`ws.terminate()` still fires `close` once the underlying connection
 * actually tears down) never double-runs cleanup — e.g. a duplicate
 * presence-offline broadcast or `updateLastSeen` call.
 * @type {WeakSet<import('ws').WebSocket>}
 */
const cleanedUpSockets = new WeakSet();

/**
 * Remove a socket from every index it participates in: `register_also`
 * delegations, `socketMeta`, the heartbeat's own tracking, and — when it was
 * the DID's last open socket — `didSockets` plus the last-seen/presence
 * side effects. Shared by the normal `close` handler and the heartbeat's
 * dead-socket path so "immediate removal from didSockets" means the same
 * thing from either trigger (#2099).
 */
function cleanupSocket(ws, meta) {
  if (cleanedUpSockets.has(ws)) return;
  cleanedUpSockets.add(ws);

  alsoRegistry.cleanup(ws, meta);
  socketMeta.delete(ws);
  heartbeat.untrack(ws);

  const closeDid = meta.did;
  if (!closeDid) return;
  const sockets = didSockets.get(closeDid);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size !== 0) return;

  didSockets.delete(closeDid);
  // Fire-and-forget: both already swallow their own errors internally, and
  // neither result gates anything else in this cleanup.
  updateLastSeen(closeDid);
  for (const [convId, convTyping] of typingStatus.entries()) {
    if (convTyping.has(closeDid)) {
      handleStopTyping(convId, closeDid);
    }
  }
  broadcastPresenceChange(closeDid, false);
}

function setupWebSocket(server) {
  wss = new WebSocketServer({ noServer: true });
  heartbeat.start(() => socketMeta.entries(), cleanupSocket);

  server.on('upgrade', async (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    const safePath = pathname.replace(/[\x00-\x1f\x7f]/g, '').substring(0, 100);
    console.log('[WS] Upgrade request for:', safePath);
    if (pathname !== '/ws' && pathname !== '/chat/ws') {
      socket.destroy();
      return;
    }

    // Try cookie auth first, but allow deferred auth via first message
    const did = await authenticateWithCookie(req);

    wss.handleUpgrade(req, socket, head, (ws) => {
      const meta = { did: did || null, alsoDids: new Set(), subscriptions: new Set(), authenticated: !!did };
      socketMeta.set(ws, meta);
      heartbeat.track(ws);
      ws.on('pong', () => heartbeat.markAlive(ws));

      if (did) {
        if (!didSockets.has(did)) didSockets.set(did, new Set());
        didSockets.get(did).add(ws);
        ws.send(JSON.stringify({ type: 'connected' }));
        // Fire-and-forget: a missed replay here is retried on the next
        // reconnect, never a reason to hold up the connection (#2044).
        notificationBacklog.replay(ws, did);
        if (didSockets.get(did).size === 1) {
          broadcastPresenceChange(did, true);
        }
      } else {
        // Allow unauthenticated connection — must send 'auth' message first
        ws.send(JSON.stringify({ type: 'auth_required' }));
      }

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          await dispatchMessage(ws, meta, msg);
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
        }
      });

      ws.on('close', () => cleanupSocket(ws, meta));
    });
  });
}

/**
 * Send a JSON payload to all sockets for a given DID (user may have multiple tabs/devices open).
 * Returns true if at least one socket received the message.
 */
function sendToDid(did, payload) {
  // Own sockets plus any delegate registered for this DID (#1653).
  const sockets = alsoRegistry.recipientsFor(did, didSockets.get(did));
  if (!sockets) return false;
  const msg = JSON.stringify(payload);
  let sent = false;
  for (const ws of sockets) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(msg);
      sent = true;
    }
  }
  return sent;
}

/**
 * Broadcast an arbitrary payload to all connected sockets subscribed to this conversation or DID.
 */
function broadcastEvent(conversationId, payload) {
  if (!wss) return;
  const payloadStr = JSON.stringify(payload);
  Array.from(socketMeta).forEach(([ws, meta]) => {
    if (meta.subscriptions.has(conversationId) && ws.readyState === 1) {
      ws.send(payloadStr);
    }
  });
}

/**
 * Broadcast a new message to all connected sockets subscribed to this conversation or DID.
 * conversationId may be a legacy UUID or a DID (did:imajin:...).
 */
function broadcastMessage(conversationId, message) {
  broadcastEvent(conversationId, { type: 'new_message', message });
}

/**
 * Paths that push an arbitrary JSON frame to every socket for one DID.
 *
 * `did-push` is the general name (#1644 — notification frames); `bump-notify` is
 * the original bump-specific path and stays an alias so existing callers keep
 * working. Both are the same DID fan-out — only the frame differs.
 */
const DID_PUSH_PATHS = new Set([
  '/chat/api/internal/did-push',
  '/chat/api/internal/bump-notify',
]);

/**
 * Set up a local HTTP endpoint on the main server for broadcasting.
 * Next.js API routes call this to push messages through the WS server.
 */
function setupBroadcastRoute(server) {
  const originalListeners = server.listeners('request').slice();
  server.removeAllListeners('request');

  server.on('request', (req, res) => {
    if (req.method === 'POST' && DID_PUSH_PATHS.has(req.url)) {
      const internalKey = req.headers['x-internal-key'];
      if (!internalKey || internalKey !== process.env.AUTH_INTERNAL_API_KEY) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { targetDid, event } = JSON.parse(body);
          if (!targetDid || !event) {
            res.writeHead(400);
            res.end('Bad request');
            return;
          }
          const delivered = sendToDid(targetDid, event);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ delivered }));
        } catch {
          res.writeHead(400);
          res.end('Bad request');
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/__ws_broadcast') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { conversationId, type, ...rest } = JSON.parse(body);
          if (type) {
            broadcastEvent(conversationId, { type, ...rest });
          } else {
            broadcastMessage(conversationId, rest.message);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end('Bad request');
        }
      });
      return;
    }
    // Pass through to original handlers (Next.js)
    for (const listener of originalListeners) {
      listener.call(server, req, res);
    }
  });
}

module.exports = { setupWebSocket, broadcastMessage, broadcastEvent, setupBroadcastRoute, sendToDid };
