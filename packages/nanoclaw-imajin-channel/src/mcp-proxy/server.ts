/**
 * MCP proxy server (imajin-ai#1932). NanoClaw's `http` MCP server shape
 * (`{ type: 'http', url, headers? }`) carries only STATIC headers — no
 * runtime refresh hook — but `mcp.imajin.ai` requires a short-lived
 * (10-minute), caller-refreshed app-token JWT (imajin-ai#1922 finding 6).
 * This process is the smallest possible sidecar for that missing extension
 * point: NanoClaw's `container.json` MCP entry points at
 * `127.0.0.1:<port>/mcp`, and this proxy mints/refreshes the token and
 * forwards every request to the real MCP server with a fresh bearer.
 *
 * Binds `127.0.0.1` by default — never expose this on a public interface,
 * since anything that can reach it can call MCP tools as this agent.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { loadMcpProxyConfig, type McpProxyConfig } from './config.js';
import { loadKeypair } from '../config-from-env.js';
import { RouteTokenProvider, type TokenSource } from './token-provider.js';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface McpProxyDeps {
  config: McpProxyConfig;
  tokenProvider: TokenSource;
}

/**
 * Resolve the forwarded target URL, and refuse to forward anywhere outside
 * the configured MCP server's own origin. `new URL(path, base)` ignores
 * `base` entirely when `path` itself looks like an absolute or
 * protocol-relative URL (e.g. `http://evil.example/x` or `//evil.example/x`)
 * — since `path` here is derived from an inbound request, that would let a
 * caller redirect this proxy's bearer token to an arbitrary host (SSRF).
 * Comparing the resolved origin against the configured one closes that gap
 * regardless of how `path` is crafted.
 */
function resolveMcpTargetUrl(path: string, mcpServerUrl: string): URL {
  const configuredOrigin = new URL(mcpServerUrl).origin;
  const target = new URL(path, mcpServerUrl);
  if (target.origin !== configuredOrigin) {
    throw new Error(`mcp-proxy: refusing to forward outside the configured MCP server origin (${configuredOrigin})`);
  }
  return target;
}

/**
 * Forward one request to the real MCP server with a fresh bearer token.
 * On a 401 from upstream, invalidate the cached token and retry once —
 * mirrors `openclaw-infer-passthrough`'s single-retry-on-401 discipline.
 */
export async function forwardToMcp(
  deps: McpProxyDeps,
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  attempt = 0,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const token = await deps.tokenProvider.getToken();
  const target = resolveMcpTargetUrl(path, deps.config.mcpServerUrl);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? httpsRequest : httpRequest;

  const forwardedHeaders: Record<string, string> = {
    'content-type': (headers['content-type'] as string) || 'application/json',
    authorization: `Bearer ${token}`,
    host: target.host,
  };

  return new Promise((resolve, reject) => {
    const req = transport(
      target,
      { method, headers: forwardedHeaders, timeout: deps.config.timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 502;
          if (status === 401 && attempt === 0) {
            deps.tokenProvider.invalidate();
            resolve(forwardToMcp(deps, method, path, headers, body, attempt + 1));
            return;
          }
          const resHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') resHeaders[key] = value;
          }
          resolve({ status, headers: resHeaders, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('mcp-proxy: upstream request timed out')));
    if (body.length > 0) req.write(body);
    req.end();
  });
}

export function createMcpProxyServer(deps: McpProxyDeps): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    void handleRequest(deps, req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'mcp_proxy_error', message: err instanceof Error ? err.message : String(err) }));
    });
  });
}

async function handleRequest(deps: McpProxyDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const body = await readBody(req);
  const result = await forwardToMcp(deps, req.method ?? 'GET', url.pathname + url.search, req.headers, body);
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}

export function startMcpProxy(config: McpProxyConfig = loadMcpProxyConfig()): ReturnType<typeof createServer> {
  const { privateKey } = loadKeypair(config.keypairPath);
  const tokenProvider = new RouteTokenProvider(config.kernelBaseUrl, config.agentDid, privateKey, config.attestationId);
  const server = createMcpProxyServer({ config, tokenProvider });
  server.listen(config.port, config.host, () => {
    console.log(`[mcp-proxy] listening on ${config.host}:${config.port}, forwarding to ${config.mcpServerUrl}`);
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startMcpProxy();
}
