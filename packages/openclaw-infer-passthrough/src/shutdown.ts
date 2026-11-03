import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createLogger } from './logger.js';

const log = createLogger('openclaw-infer-passthrough');
const DEFAULT_GRACE_MS = 5_000;
const MAX_GRACE_MS = 8_000;

/** Invalid configuration falls back safely; no input can extend systemd's deadline. */
export function shutdownGraceMs(raw = process.env.INFER_PROXY_SHUTDOWN_GRACE_MS): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_GRACE_MS)
    : DEFAULT_GRACE_MS;
}

/**
 * Install before accepting requests. Keep signal ownership in the executable,
 * not in imported servers. Counting response finish/close includes streaming bodies.
 */
export function installGracefulShutdown(
  server: Server,
  { graceMs = shutdownGraceMs(), exit = (code: number) => process.exit(code) }:
    { graceMs?: number; exit?: (code: number) => void } = {},
) {
  const listeners = server.listeners('request');
  server.removeAllListeners('request');
  const active = new Set<ServerResponse>();
  let draining = false;
  let finished = false;
  let inFlightAtSignal = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (draining) {
      res.writeHead(503, { Connection: 'close', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'shutting_down' }));
      req.resume();
      return;
    }
    active.add(res);
    const completed = () => {
      active.delete(res);
      res.off('finish', completed);
      res.off('close', completed);
      // Node marks the socket idle after emitting finish; reap on the next turn.
      if (draining) setImmediate(() => server.closeIdleConnections());
    };
    res.once('finish', completed);
    res.once('close', completed);
    for (const listener of listeners) listener.call(server, req, res);
  });

  function dispose() {
    clearTimeout(timer);
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  }

  function finish(cutAtGrace: boolean) {
    if (finished) return;
    finished = true;
    dispose();
    server.closeAllConnections();
    log.info({ inFlightAtSignal, cutAtGrace }, 'openclaw-infer-passthrough shutdown complete');
    // Also terminates upstream fetches and any unrelated stray handles.
    exit(0);
  }

  function shutdown() {
    if (draining) {
      finish(false);
      return;
    }
    draining = true;
    inFlightAtSignal = active.size;
    log.info({ inFlightAtSignal }, 'openclaw-infer-passthrough draining');
    timer = setTimeout(() => finish(true), shutdownGraceMs(String(graceMs)));
    timer.unref();
    server.close(() => finish(false));
    server.closeIdleConnections();
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return { shutdown, dispose };
}
