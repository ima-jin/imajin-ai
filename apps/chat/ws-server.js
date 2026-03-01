const { WebSocketServer } = require('ws');

/** @type {Map<import('ws').WebSocket, { did: string, subscriptions: Set<string> }>} */
const socketMeta = new Map();
/** @type {Map<string, Set<import('ws').WebSocket>>} */
const didSockets = new Map();

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
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
        }
      });

      ws.on('close', () => {
        socketMeta.delete(ws);
        const sockets = didSockets.get(did);
        if (sockets) {
          sockets.delete(ws);
          if (sockets.size === 0) didSockets.delete(did);
        }
      });

      ws.send(JSON.stringify({ type: 'connected' }));
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
