const { WebSocketServer } = require('ws');
const { createAlsoRegistry } = require('./src/lib/ws/also-registry');

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

function setupWebSocket(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    const safePath = pathname.replace(/[\r\n\x00-\x1f\x7f]/g, '').substring(0, 100);
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

      if (did) {
        if (!didSockets.has(did)) didSockets.set(did, new Set());
        didSockets.get(did).add(ws);
        ws.send(JSON.stringify({ type: 'connected' }));
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

          // Handle deferred auth via WS token
          if (msg.type === 'auth' && msg.token && !meta.authenticated) {
            const authedDid = await authenticateWsToken(msg.token);
            if (authedDid) {
              meta.did = authedDid;
              meta.authenticated = true;
              if (!didSockets.has(authedDid)) didSockets.set(authedDid, new Set());
              didSockets.get(authedDid).add(ws);
              ws.send(JSON.stringify({ type: 'connected' }));
              if (didSockets.get(authedDid).size === 1) {
                broadcastPresenceChange(authedDid, true);
              }
              console.log('[WS] Deferred auth succeeded for:', authedDid);
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }));
              ws.close(4001, 'Authentication failed');
            }
            return;
          }

          // Reject other messages if not authenticated
          if (!meta.authenticated) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated. Send auth message first.' }));
            return;
          }

          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'register_also' || msg.type === 'unregister_also') {
            // Agent delegation: also receive notifications for this DID (#1545/#1653).
            // The registry verifies the delegation before it registers anything.
            const frame = await alsoRegistry.handle(ws, meta, msg);
            if (frame && ws.readyState === 1) ws.send(JSON.stringify(frame));
          } else if (msg.type === 'subscribe') {
            if (msg.conversationId) meta.subscriptions.add(msg.conversationId);
            if (msg.did) meta.subscriptions.add(msg.did);
          } else if (msg.type === 'typing') {
            const channel = msg.did || msg.conversationId;
            if (channel) handleTyping(channel, meta.did, msg.name || null);
          } else if (msg.type === 'stop_typing') {
            const channel = msg.did || msg.conversationId;
            if (channel) handleStopTyping(channel, meta.did);
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
        }
      });

      ws.on('close', async () => {
        const closeDid = meta.did;
        alsoRegistry.cleanup(ws, meta);
        socketMeta.delete(ws);
        if (closeDid) {
          const sockets = didSockets.get(closeDid);
          if (sockets) {
            sockets.delete(ws);
            if (sockets.size === 0) {
              didSockets.delete(closeDid);
              await updateLastSeen(closeDid);
              for (const [convId, convTyping] of typingStatus.entries()) {
                if (convTyping.has(closeDid)) {
                  handleStopTyping(convId, closeDid);
                }
              }
              broadcastPresenceChange(closeDid, false);
            }
          }
        }
      });
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
