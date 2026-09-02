/**
 * Core request orchestration for `POST /v1/chat/completions` and
 * `POST /:providerId/v1/chat/completions` (imajin-ai#1926).
 *
 * Deliberately decoupled from `node:http` so it can be exercised directly in
 * tests without a real socket (see `tests/handle-completions.test.ts`) — the
 * HTTP adapter lives in `server.ts`.
 *
 * Decision rules (from the issue):
 *   - 4xx from the kernel (auth/scope/422 NoModelSelected/...) is a client
 *     error — forwarded verbatim, never triggers fallback. The one exception
 *     is a 401, which is retried once with a freshly-minted token before
 *     being treated as a final 4xx (a persistent 401 after retry means the
 *     grant itself is bad, not that the token merely expired early).
 *   - 5xx from the kernel, or a time-to-first-byte timeout / network failure,
 *     triggers break-glass fallback to the route's direct endpoint — if one
 *     is configured. If not, the kernel's own error is surfaced.
 */
import type { HealthTracker } from './health.js';
import type { Logger } from './logger.js';
import { resolveRoute } from './router.js';
import type { TokenSource } from './token-provider.js';
import { forwardDirect, forwardToKernel, UpstreamTimeoutError, UpstreamUnavailableError } from './upstream.js';
import type { ProviderRouteConfig } from './types.js';

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Response['body'];
}

export interface IncomingCompletionsRequest {
  providerIdFromPath?: string;
  bodyText: string;
  sessionId?: string;
  turnId?: string;
}

export interface HandleCompletionsDeps {
  routes: readonly ProviderRouteConfig[];
  kernelBaseUrl: string;
  kernelTimeoutMs: number;
  directTimeoutMs: number;
  getTokenProvider(routeId: string): TokenSource;
  resolveDirectApiKey(route: ProviderRouteConfig): string | undefined;
  health: HealthTracker;
  log: Logger;
}

function jsonError(status: number, error: string, message: string): ProxyResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: toBody(JSON.stringify({ error, message })),
  };
}

function toBody(text: string): Response['body'] {
  return new Response(text).body;
}

function toProxyResponse(res: Response): ProxyResponse {
  const headers: Record<string, string> = {};
  const contentType = res.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    headers['Cache-Control'] = 'no-cache';
    headers['Connection'] = 'keep-alive';
  }
  return { status: res.status, headers, body: res.body };
}

function extractModel(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

export async function handleCompletions(
  deps: HandleCompletionsDeps,
  req: IncomingCompletionsRequest,
): Promise<ProxyResponse> {
  const model = extractModel(req.bodyText);
  const route = resolveRoute(deps.routes, req.providerIdFromPath, model);
  if (!route) {
    return jsonError(
      422,
      'no_route_for_model',
      req.providerIdFromPath
        ? `No configured route '${req.providerIdFromPath}'`
        : `No route configured matches model ${JSON.stringify(model ?? null)}; use a path-prefixed route or add a modelPrefixes entry`,
    );
  }

  const tokenProvider = deps.getTokenProvider(route.id);

  try {
    const kernelResponse = await attemptKernelCall(deps, route, tokenProvider, req);
    if (kernelResponse.status >= 500) {
      return await attemptFallback(deps, route, req, `kernel returned ${kernelResponse.status}`);
    }
    deps.health.recordKernelSuccess();
    return toProxyResponse(kernelResponse);
  } catch (err) {
    if (err instanceof UpstreamTimeoutError || err instanceof UpstreamUnavailableError) {
      return await attemptFallback(deps, route, req, err.message);
    }
    throw err;
  }
}

/** Call the kernel, retrying once with a freshly-minted token on a 401. */
async function attemptKernelCall(
  deps: HandleCompletionsDeps,
  route: ProviderRouteConfig,
  tokenProvider: TokenSource,
  req: IncomingCompletionsRequest,
): Promise<Response> {
  const token = await tokenProvider.getToken();
  const first = await forwardToKernel(deps.kernelBaseUrl, token, req.bodyText, deps.kernelTimeoutMs, {
    sessionId: req.sessionId,
    turnId: req.turnId,
  });
  if (first.status !== 401) return first;

  deps.log.warn({ route: route.id }, 'kernel rejected app token with 401 — reminting and retrying once');
  tokenProvider.invalidate();
  const freshToken = await tokenProvider.getToken();
  return forwardToKernel(deps.kernelBaseUrl, freshToken, req.bodyText, deps.kernelTimeoutMs, {
    sessionId: req.sessionId,
    turnId: req.turnId,
  });
}

/** Break-glass: try the route's direct endpoint, or surface the original kernel failure. */
async function attemptFallback(
  deps: HandleCompletionsDeps,
  route: ProviderRouteConfig,
  req: IncomingCompletionsRequest,
  reason: string,
): Promise<ProxyResponse> {
  const directApiKey = deps.resolveDirectApiKey(route);
  if (!route.directBaseUrl || !directApiKey) {
    deps.log.error({ route: route.id, reason }, 'kernel unavailable and no break-glass direct endpoint configured');
    return jsonError(502, 'kernel_unavailable', `Kernel passthrough failed (${reason}) and no break-glass fallback is configured for '${route.id}'`);
  }

  try {
    const direct = await forwardDirect(route, directApiKey, req.bodyText, deps.directTimeoutMs);
    deps.health.recordFallback();
    deps.log.warn({ route: route.id, reason, status: direct.status }, 'break-glass: fell back to direct provider endpoint');
    return toProxyResponse(direct);
  } catch (err) {
    deps.health.recordFallback();
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.error({ route: route.id, reason, detail }, 'break-glass fallback itself failed');
    return jsonError(502, 'fallback_failed', `Kernel passthrough failed (${reason}) and the break-glass fallback also failed: ${detail}`);
  }
}
