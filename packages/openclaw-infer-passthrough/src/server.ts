/**
 * HTTP adapter (imajin-ai#1926). Binds `127.0.0.1` by default — this proxy is
 * meant to be reachable only from OpenClaw on the same gateway host, never
 * exposed on a public interface, since a leaked bearer to it would let a
 * caller mint on this app's behalf.
 *
 * Routes:
 *   POST /:providerId/v1/chat/completions  — explicit route selection
 *   POST /v1/chat/completions              — route selection via body.model
 *   GET  /healthz                          — break-glass observability (imajin-ai#1922 guardrail)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { loadConfig, resolveDirectApiKey } from './config.js';
import { HealthTracker } from './health.js';
import { handleCompletions } from './handle-completions.js';
import { createLogger } from './logger.js';
import { RouteTokenProvider } from './token-provider.js';
import type { ProxyConfig } from './types.js';

const log = createLogger('openclaw-infer-passthrough');

const COMPLETIONS_PATH_RE = /^\/(?:([a-zA-Z0-9_-]+)\/)?v1\/chat\/completions\/?$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function writeProxyResponse(res: ServerResponse, status: number, headers: Record<string, string>, body: Response['body']): Promise<void> {
  res.writeHead(status, headers);
  if (!body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const nodeStream = Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream);
    nodeStream.on('error', reject);
    res.on('error', reject);
    nodeStream.pipe(res);
    res.on('finish', resolve);
  });
}

export function createProxyServer(config: ProxyConfig) {
  const health = new HealthTracker();
  const tokenProviders = new Map<string, RouteTokenProvider>();

  function getTokenProvider(routeId: string): RouteTokenProvider {
    let provider = tokenProviders.get(routeId);
    if (!provider) {
      const route = config.routes.find((r) => r.id === routeId);
      if (!route) throw new Error(`Unknown route '${routeId}'`);
      provider = new RouteTokenProvider(config.kernelBaseUrl, config.appDid, config.appPrivateKey, route.attestationId);
      tokenProviders.set(routeId, provider);
    }
    return provider;
  }

  const deps = {
    routes: config.routes,
    kernelBaseUrl: config.kernelBaseUrl,
    kernelTimeoutMs: config.kernelTimeoutMs,
    directTimeoutMs: config.directTimeoutMs,
    getTokenProvider,
    resolveDirectApiKey: (route: (typeof config.routes)[number]) => resolveDirectApiKey(route),
    health,
    log,
  };

  return createServer((req, res) => {
    void routeRequest(req, res, deps, health).catch((err: unknown) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled request error');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal_error', message: 'The passthrough shim failed unexpectedly' }));
    });
  });
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Parameters<typeof handleCompletions>[0],
  health: HealthTracker,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const body = JSON.stringify(health.snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  const match = req.method === 'POST' ? COMPLETIONS_PATH_RE.exec(url.pathname) : null;
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', message: 'Unknown route' }));
    return;
  }

  const bodyText = await readBody(req);
  const result = await handleCompletions(deps, {
    providerIdFromPath: match[1],
    bodyText,
    sessionId: req.headers['x-session-id'] as string | undefined,
    turnId: req.headers['x-turn-id'] as string | undefined,
  });
  await writeProxyResponse(res, result.status, result.headers, result.body);
}

export function startServer(config: ProxyConfig = loadConfig()): ReturnType<typeof createServer> {
  const server = createProxyServer(config);
  server.listen(config.port, config.host, () => {
    log.info({ host: config.host, port: config.port, routes: config.routes.map((r) => r.id) }, 'openclaw-infer-passthrough listening');
  });
  return server;
}

// Only auto-start when run directly (tsx src/server.ts), not when imported by tests.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer();
}
