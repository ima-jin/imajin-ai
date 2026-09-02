/**
 * Shared kernel-then-break-glass dispatch orchestration (imajin-ai#1926,
 * generalized for imajin-ai#1959's Anthropic-format sibling).
 *
 * `handle-completions.ts` (OpenAI-compatible) and `anthropic-handler.ts`
 * (Anthropic-format) both forward to the kernel, retry once on a 401 with a
 * freshly-minted token, and fall back to a direct provider endpoint on a
 * kernel 5xx or time-to-first-byte timeout — never on any other 4xx. That
 * decision flow is identical between the two wire formats; only HOW to build
 * the kernel/direct request differs (URL, headers). This module owns the
 * flow once; each format's handler supplies just the two upstream calls as
 * callbacks.
 *
 * Decision rules (from the #1926 issue, unchanged by #1959):
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
import type { Logger, LogFields } from './logger.js';
import type { TokenSource } from './token-provider.js';
import { UpstreamTimeoutError, UpstreamUnavailableError } from './upstream.js';
import type { ProviderRouteConfig } from './types.js';

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Response['body'];
}

export interface DispatchDeps {
  route: ProviderRouteConfig;
  getTokenProvider(routeId: string): TokenSource;
  resolveDirectApiKey(route: ProviderRouteConfig): string | undefined;
  health: HealthTracker;
  log: Logger;
}

function toBody(text: string): Response['body'] {
  return new Response(text).body;
}

export function jsonError(status: number, error: string, message: string): ProxyResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: toBody(JSON.stringify({ error, message })),
  };
}

export function toProxyResponse(res: Response): ProxyResponse {
  const headers: Record<string, string> = {};
  const contentType = res.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    headers['Cache-Control'] = 'no-cache';
    headers['Connection'] = 'keep-alive';
  }
  return { status: res.status, headers, body: res.body };
}

/**
 * Run one request through the kernel-then-break-glass flow.
 *
 * @param callKernel  Forward the request to the kernel using the given
 *   bearer/x-api-key token. Called twice on a 401 (once with the cached
 *   token, once with a freshly-minted one).
 * @param callDirect  Forward the request straight to the direct provider
 *   endpoint using the given direct API key. Only called on a kernel 5xx or
 *   TTFB timeout/network failure, and only when the route has both a
 *   `directBaseUrl` and a resolvable direct key.
 * @param logFields   Extra fields (e.g. `{ endpoint: 'count_tokens' }`)
 *   merged into every log line this dispatch emits, alongside `route`.
 */
export async function dispatchWithBreakGlass(
  deps: DispatchDeps,
  callKernel: (token: string) => Promise<Response>,
  callDirect: (directApiKey: string) => Promise<Response>,
  logFields: LogFields = {},
): Promise<ProxyResponse> {
  const tokenProvider = deps.getTokenProvider(deps.route.id);

  try {
    const kernelResponse = await attemptKernelCall(deps, tokenProvider, callKernel, logFields);
    if (kernelResponse.status >= 500) {
      return await attemptFallback(deps, callDirect, `kernel returned ${kernelResponse.status}`, logFields);
    }
    deps.health.recordKernelSuccess();
    return toProxyResponse(kernelResponse);
  } catch (err) {
    if (err instanceof UpstreamTimeoutError || err instanceof UpstreamUnavailableError) {
      return await attemptFallback(deps, callDirect, err.message, logFields);
    }
    throw err;
  }
}

/** Call the kernel, retrying once with a freshly-minted token on a 401. */
async function attemptKernelCall(
  deps: DispatchDeps,
  tokenProvider: TokenSource,
  callKernel: (token: string) => Promise<Response>,
  logFields: LogFields,
): Promise<Response> {
  const token = await tokenProvider.getToken();
  const first = await callKernel(token);
  if (first.status !== 401) return first;

  deps.log.warn({ route: deps.route.id, ...logFields }, 'kernel rejected app token with 401 — reminting and retrying once');
  tokenProvider.invalidate();
  const freshToken = await tokenProvider.getToken();
  return callKernel(freshToken);
}

/** Break-glass: try the route's direct endpoint, or surface the original kernel failure. */
async function attemptFallback(
  deps: DispatchDeps,
  callDirect: (directApiKey: string) => Promise<Response>,
  reason: string,
  logFields: LogFields,
): Promise<ProxyResponse> {
  const directApiKey = deps.resolveDirectApiKey(deps.route);
  if (!deps.route.directBaseUrl || !directApiKey) {
    deps.log.error({ route: deps.route.id, ...logFields, reason }, 'kernel unavailable and no break-glass direct endpoint configured');
    return jsonError(
      502,
      'kernel_unavailable',
      `Kernel passthrough failed (${reason}) and no break-glass fallback is configured for '${deps.route.id}'`,
    );
  }

  try {
    const direct = await callDirect(directApiKey);
    deps.health.recordFallback();
    deps.log.warn({ route: deps.route.id, ...logFields, reason, status: direct.status }, 'break-glass: fell back to direct endpoint');
    return toProxyResponse(direct);
  } catch (err) {
    deps.health.recordFallback();
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.error({ route: deps.route.id, ...logFields, reason, detail }, 'break-glass fallback itself failed');
    return jsonError(502, 'fallback_failed', `Kernel passthrough failed (${reason}) and the break-glass fallback also failed: ${detail}`);
  }
}
