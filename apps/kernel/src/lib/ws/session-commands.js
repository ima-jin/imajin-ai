/** The command transport never consults register_also, subscriptions, or user payload DIDs. */
const SESSION_COMMAND_PATH = '/chat/api/internal/session-command';
const MAX_BODY_BYTES = 32 * 1024;

function sendOwnSessionCommand(didSockets, socketMeta, targetDid, command) {
  if (!command || command.to !== targetDid || !/^session\.(send|abort|spawn|approve|deny)$/.test(command.type)) return false;
  const sockets = didSockets.get(targetDid);
  const serialized = JSON.stringify(command);
  for (const ws of sockets ?? []) {
    const meta = socketMeta.get(ws);
    if (ws.readyState !== 1 || !meta?.authenticated || meta.did !== targetDid) continue;
    try {
      // One own socket only: duplicate harness connections must not execute twice.
      ws.send(serialized);
      return true;
    } catch {
      // Try another socket only when send synchronously rejected.
    }
  }
  return false;
}

function reply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function handleSessionCommandRequest(req, res, didSockets, socketMeta, key) {
  if (!key || req.headers['x-internal-key'] !== key) {
    reply(res, 401, { error: 'Unauthorized' });
    return;
  }
  let body = '';
  let oversized = false;
  req.on('data', chunk => {
    if (oversized) return;
    body += chunk;
    oversized = Buffer.byteLength(body) > MAX_BODY_BYTES;
  });
  req.on('end', () => {
    if (oversized) return reply(res, 413, { error: 'Frame too large' });
    try {
      const { targetDid, command } = JSON.parse(body);
      if (typeof targetDid !== 'string' || command?.to !== targetDid) {
        reply(res, 400, { error: 'Invalid command target' });
        return;
      }
      reply(res, 200, { delivered: sendOwnSessionCommand(didSockets, socketMeta, targetDid, command) });
    } catch {
      reply(res, 400, { error: 'Invalid command' });
    }
  });
}

function isSessionEvent(type) {
  return type === 'loop.approval.bound' || /^loop\.session\.(send|abort|spawn|approve|deny)\.(completed|failed)$/.test(type);
}

async function forwardSessionEvent(meta, frame) {
  const key = process.env.AUTH_INTERNAL_API_KEY;
  if (!meta.authenticated || !meta.did || !key || !isSessionEvent(frame.type)) return;
  if (Buffer.byteLength(JSON.stringify(frame)) > 24 * 1024) return;
  const port = process.env.PORT || '3000';
  try {
    await fetch(`http://localhost:${port}/jin/api/internal/session-events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
      body: JSON.stringify({ socketDid: meta.did, frame }), signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Never reflect private signed payloads or provider errors onto the socket.
  }
}

module.exports = { SESSION_COMMAND_PATH, sendOwnSessionCommand, handleSessionCommandRequest, isSessionEvent, forwardSessionEvent };
