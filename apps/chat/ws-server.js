const { WebSocketServer } = require('ws');

/** @type {Map<import('ws').WebSocket, { did: string, subscriptions: Set<string> }>} */
const socketMeta = new Map();
/** @type {Map<string, Set<import('ws').WebSocket>>} */
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

async function authenticateRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['imajin_session'];
  console.log('[WS] Auth attempt, cookie present:', !!token);
  if (!token) return null;

  const authUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
  try {
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `imajin_session=${token}` },
    });
    console.log('[WS] Auth response:', res.status);
    if (!res.ok) return null;
    const data = await res.json();
    const did = data.did || data.identity?.did || null;
    console.log('[WS] Authenticated DID:', did);
    return did;
  } catch (err) {
    console.error('[WS] Auth error:', err.message);
    return null;
  }
}

/**
 * Update last_seen_at for a user going offline
 */
async function updateLastSeen(did) {
  try {
    const profileUrl = process.env.PROFILE_SERVICE_URL || 'http://localhost:3004';
    await fetch(`${profileUrl}/api/presence/update`, {
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
        meta.did !== excludeDid) {
      ws.send(payloadStr);
    }
  }
}

/**
 * Broadcast presence change to relevant conversations
 */
async function broadcastPresenceChange(did, isOnline) {
  // Get all conversations this user participates in
  try {
    const chatUrl = process.env.CHAT_SERVICE_URL || 'http://localhost:3002';
    const res = await fetch(`${chatUrl}/api/participants/${encodeURIComponent(did)}/conversations`);
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

function setupWebSocket(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    console.log('[WS] Upgrade request for:', pathname);
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const did = await authenticateRequest(req);
    if (!did) {
      console.log('[WS] Rejecting - no auth');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    console.log('[WS] Accepting connection for:', did);

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Track connection
      const meta = { did, subscriptions: new Set() };
      socketMeta.set(ws, meta);
      if (!didSockets.has(did)) didSockets.set(did, new Set());
      didSockets.get(did).add(ws);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'subscribe' && msg.conversationId) {
            meta.subscriptions.add(msg.conversationId);
          } else if (msg.type === 'typing' && msg.conversationId) {
            handleTyping(msg.conversationId, did, msg.name || null);
          } else if (msg.type === 'stop_typing' && msg.conversationId) {
            handleStopTyping(msg.conversationId, did);
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
        }
      });

      ws.on('close', async () => {
        socketMeta.delete(ws);
        const sockets = didSockets.get(did);
        if (sockets) {
          sockets.delete(ws);
          if (sockets.size === 0) {
            didSockets.delete(did);
            // User went offline, update last_seen_at
            await updateLastSeen(did);
            // Clear any typing indicators for this user
            for (const [convId, typingUsers] of typingStatus.entries()) {
              if (typingUsers.has(did)) {
                handleStopTyping(convId, did);
              }
            }
            // Broadcast offline status to relevant conversations
            broadcastPresenceChange(did, false);
          }
        }
      });

      ws.send(JSON.stringify({ type: 'connected' }));

      // If this is the first connection for this DID, broadcast online status
      if (didSockets.get(did).size === 1) {
        broadcastPresenceChange(did, true);
      }
    });
  });
}

/**
 * Broadcast a new message to all connected sockets subscribed to this conversation.
 */
function broadcastMessage(conversationId, message) {
  if (!wss) return;
  const payload = JSON.stringify({ type: 'new_message', message });
  for (const [ws, meta] of socketMeta) {
    if (meta.subscriptions.has(conversationId) && ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

/**
 * Set up a local HTTP endpoint on the main server for broadcasting.
 * Next.js API routes call this to push messages through the WS server.
 */
function setupBroadcastRoute(server) {
  const originalListeners = server.listeners('request').slice();
  server.removeAllListeners('request');
  
  server.on('request', (req, res) => {
    if (req.method === 'POST' && req.url === '/__ws_broadcast') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { conversationId, message } = JSON.parse(body);
          broadcastMessage(conversationId, message);
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

module.exports = { setupWebSocket, broadcastMessage, setupBroadcastRoute };
