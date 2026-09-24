/**
 * HTTP adapter (imajin-ai#1926, extended by imajin-ai#1959 and imajin-ai#2368).
 * Binds `127.0.0.1` by default — this proxy is meant to be reachable only from
 * OpenClaw/NanoClaw on the same gateway host, never exposed on a public
 * interface, since a leaked bearer to it would let a caller mint on this
 * app's behalf.
 *
 * Routes:
 *   POST /:providerId/v1/chat/completions      — OpenAI-compatible, explicit route selection
 *   POST /v1/chat/completions                  — OpenAI-compatible, route selection via body.model
 *   GET  /openai/v1/models                     — OpenAI-compatible model discovery (imajin-ai#2201)
 *   POST /anthropic/v1/messages                — Anthropic-format raw passthrough (imajin-ai#1959)
 *   POST /anthropic/v1/messages/count_tokens   — Anthropic-format token counting (imajin-ai#1959)
 *   POST /mcp                                  — native MCP JSON-RPC passthrough (imajin-ai#2368)
 *   GET  /healthz                              — break-glass observability (imajin-ai#1922 guardrail), shared by every format
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { loadConfig, resolveDirectApiKey } from './config.js';
import { HealthTracker } from './health.js';
import { handleCompletions } from './handle-completions.js';
import { handleModels } from './handle-models.js';
import { handleAnthropicRequest, type AnthropicEndpoint } from './anthropic-handler.js';
import { handleMcpRequest } from './mcp-handler.js';
import { createLogger } from './logger.js';
import { RouteTokenProvider } from './token-provider.js';
import { stripTrailingSlashes } from './url-utils.js';
import type { ProxyConfig } from './types.js';

const log = createLogger('openclaw-infer-passthrough');

const COMPLETIONS_PATH_RE = /^\/(?:([a-zA-Z0-9_-]+)\/)?v1\/chat\/completions\/?$/;

/** `GET /openai/v1/models` — model discovery for the `openai` seat's OpenClaw custom-provider `baseUrl` (imajin-ai#2201). */
const MODELS_PATH_RE = /^\/openai\/v1\/models\/?$/;

/** `/anthropic/v1/messages` or `/anthropic/v1/messages/count_tokens` — the fixed prefix a container points `ANTHROPIC_BASE_URL` at (imajin-ai#1959). */
const ANTHROPIC_PATH_RE = /^\/anthropic\/v1\/messages(\/count_tokens)?\/?$/;

/** The single well-known route id every Anthropic-format request resolves against — see `anthropic-handler.ts`'s header. */
const ANTHROPIC_ROUTE_ID = 'anthropic';

/** `POST /mcp` — fronts the kernel's native MCP JSON-RPC surface (imajin-ai#2368). */
const MCP_PATH_RE = /^\/mcp\/?$/;

/** The single well-known route id every MCP request resolves against — see `mcp-handler.ts`'s header. */
const MCP_ROUTE_ID = 'mcp';

/**
 * Read one incoming correlation header, preferring the canonical
 * `X-Imajin-*` name (imajin-ai#2204) and falling back to the legacy
 * `X-Session-Id`/`X-Turn-Id` names this shim forwarded before that issue —
 * the plugin side (imajin-ai#36) sends the new names once it lands, but
 * nothing here needs to change again when it does.
 */
function readHeader(req: IncomingMessage, canonical: string, legacy?: string): string | undefined {
  const value = req.headers[canonical] ?? (legacy ? req.headers[legacy] : undefined);
  return typeof value === 'string' ? value : undefined;
}

function readCorrelationHeaders(req: IncomingMessage): { sessionId?: string; turnId?: string; warpRunId?: string } {
  return {
    sessionId: readHeader(req, 'x-imajin-session', 'x-session-id'),
    turnId: readHeader(req, 'x-imajin-turn', 'x-turn-id'),
    warpRunId: readHeader(req, 'x-imajin-run'),
  };
}

/** MCP transport headers (imajin-ai#2368) — see `mcp-handler.ts`'s auth-model doc for `X-Imajin-App-Did`. */
function readMcpHeaders(req: IncomingMessage): { appDidHeader?: string; mcpProtocolVersion?: string; mcpSessionId?: string } {
  return {
    appDidHeader: readHeader(req, 'x-imajin-app-did'),
    mcpProtocolVersion: readHeader(req, 'mcp-protocol-version'),
    mcpSessionId: readHeader(req, 'mcp-session-id'),
  };
}

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

/** RFC 8707 resource identifier the kernel's `/mcp` binds its app-token `aud` claim to — see `mintAppToken`'s doc comment. */
function mcpResourceAudience(config: ProxyConfig): string {
  return `${stripTrailingSlashes(config.mcpPublicUrl)}/mcp`;
}

export function createProxyServer(config: ProxyConfig) {
  const health = new HealthTracker();
  const tokenProviders = new Map<string, RouteTokenProvider>();
  const mcpAud = mcpResourceAudience(config);

  function getTokenProvider(routeId: string): RouteTokenProvider {
    let provider = tokenProviders.get(routeId);
    if (!provider) {
      const route = config.routes.find((r) => r.id === routeId);
      if (!route) throw new Error(`Unknown route '${routeId}'`);
      // The `mcp` route mints with NO scope narrowing (`null`) and binds the
      // token to the kernel's MCP resource audience — every other route keeps
      // the pre-#2368 default (`infer:completions`, no audience). See
      // `RouteTokenProvider`'s own doc comment for why `null`, not `undefined`.
      const isMcpRoute = routeId === MCP_ROUTE_ID;
      provider = new RouteTokenProvider(
        config.kernelBaseUrl,
        config.appDid,
        config.appPrivateKey,
        route.attestationId,
        undefined,
        undefined,
        isMcpRoute ? null : undefined,
        isMcpRoute ? mcpAud : undefined,
      );
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
  // Anthropic-format deps share every field with `deps` above except `route`,
  // which is resolved once here rather than per-request — there is exactly
  // one Anthropic route (see the module header), unlike the OpenAI-compatible
  // path's per-request lookup by path segment or `model` prefix.
  const anthropicDeps = { ...deps, route: config.routes.find((r) => r.id === ANTHROPIC_ROUTE_ID) };
  // MCP deps, same single-route shape as anthropicDeps above, plus the app
  // DID the `X-Imajin-App-Did` header is checked against (imajin-ai#2368).
  const mcpDeps = { ...deps, route: config.routes.find((r) => r.id === MCP_ROUTE_ID), appDid: config.appDid };

  return createServer((req, res) => {
    void routeRequest(req, res, deps, anthropicDeps, mcpDeps, health).catch((err: unknown) => {
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
  anthropicDeps: Parameters<typeof handleAnthropicRequest>[0],
  mcpDeps: Parameters<typeof handleMcpRequest>[0],
  health: HealthTracker,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const body = JSON.stringify(health.snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && MODELS_PATH_RE.test(url.pathname)) {
    const result = await handleModels(deps);
    await writeProxyResponse(res, result.status, result.headers, result.body);
    return;
  }

  if (req.method === 'POST' && MCP_PATH_RE.test(url.pathname)) {
    const bodyText = await readBody(req);
    const result = await handleMcpRequest(mcpDeps, { bodyText, ...readMcpHeaders(req) });
    await writeProxyResponse(res, result.status, result.headers, result.body);
    return;
  }

  const anthropicMatch = req.method === 'POST' ? ANTHROPIC_PATH_RE.exec(url.pathname) : null;
  if (anthropicMatch) {
    const endpoint: AnthropicEndpoint = anthropicMatch[1] ? 'count_tokens' : 'messages';
    const bodyText = await readBody(req);
    const result = await handleAnthropicRequest(anthropicDeps, {
      endpoint,
      bodyText,
      ...readCorrelationHeaders(req),
      anthropicVersion: req.headers['anthropic-version'] as string | undefined,
      anthropicBeta: req.headers['anthropic-beta'] as string | undefined,
    });
    await writeProxyResponse(res, result.status, result.headers, result.body);
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
    ...readCorrelationHeaders(req),
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
