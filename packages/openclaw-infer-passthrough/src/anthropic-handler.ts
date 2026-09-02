/**
 * Anthropic-format request handling (imajin-ai#1959): `POST /anthropic/v1/messages`
 * and `POST /anthropic/v1/messages/count_tokens`. A container sets
 * `ANTHROPIC_BASE_URL` to this shim's `/anthropic` prefix and authenticates
 * with `ANTHROPIC_API_KEY` (the Claude Agent SDK / Claude Code CLI send it as
 * `x-api-key` — their only auth header for a custom base URL); this shim
 * mints the short-lived kernel app-token in its place and rides it as
 * `x-api-key` on the kernel call, matching the kernel's own `x-api-key`
 * extension (`resolveInferenceAuth`, imajin-ai#1959).
 *
 * Same decision rules as `handle-completions.ts`'s OpenAI-compatible
 * sibling, reusing its `jsonError`/`toProxyResponse` shape-builders rather
 * than re-implementing them: a kernel 4xx (auth/scope/422 `no_model_selected`/
 * `no_brain`/...) is a client error, forwarded verbatim — a 401 is retried
 * once with a fresh token first. A kernel 5xx or a time-to-first-byte
 * timeout triggers break-glass fallback to the route's direct Anthropic
 * endpoint, using the SAME `directBaseUrl`/`directApiKeyEnvVar` config field
 * an OpenAI-compatible route uses — no separate config surface for this wire
 * format (see `config/routes.example.json`'s existing `"anthropic"` entry).
 *
 * There is exactly one Anthropic route in the config table (`id: 'anthropic'`)
 * — unlike the OpenAI-compatible completions path there is no per-model
 * routing to do here: every `ANTHROPIC_BASE_URL` request speaks for the one
 * sealed Anthropic connector, so the caller looks the route up by that fixed
 * id rather than by path segment or `model` prefix.
 */
import type { HealthTracker } from './health.js';
import type { Logger } from './logger.js';
import { jsonError, toProxyResponse, type ProxyResponse } from './handle-completions.js';
import type { TokenSource } from './token-provider.js';
import {
  forwardAnthropicDirect,
  forwardAnthropicToKernel,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
  type AnthropicPath,
} from './upstream.js';
import type { ProviderRouteConfig } from './types.js';

export type AnthropicEndpoint = 'messages' | 'count_tokens';

export interface IncomingAnthropicRequest {
  endpoint: AnthropicEndpoint;
  bodyText: string;
  sessionId?: string;
  turnId?: string;
  anthropicVersion?: string;
  anthropicBeta?: string;
}

export interface HandleAnthropicDeps {
  /** The single `id: 'anthropic'` route entry from the routes config, or `undefined` when unconfigured. */
  route: ProviderRouteConfig | undefined;
  kernelBaseUrl: string;
  kernelTimeoutMs: number;
  directTimeoutMs: number;
  getTokenProvider(routeId: string): TokenSource;
  resolveDirectApiKey(route: ProviderRouteConfig): string | undefined;
  health: HealthTracker;
  log: Logger;
}

function kernelPath(endpoint: AnthropicEndpoint): AnthropicPath {
  return endpoint === 'messages' ? 'messages' : 'messages/count_tokens';
}

export async function handleAnthropicRequest(
  deps: HandleAnthropicDeps,
  req: IncomingAnthropicRequest,
): Promise<ProxyResponse> {
  const { route } = deps;
  if (!route) {
    return jsonError(
      422,
      'no_route_configured',
      "No 'anthropic' route configured in INFER_PROXY_ROUTES_CONFIG — see the README's Anthropic-format section",
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

/** Call the kernel, retrying once with a freshly-minted token on a 401 — same rule `handle-completions.ts` applies. */
async function attemptKernelCall(
  deps: HandleAnthropicDeps,
  route: ProviderRouteConfig,
  tokenProvider: TokenSource,
  req: IncomingAnthropicRequest,
): Promise<Response> {
  const path = kernelPath(req.endpoint);
  const headers = {
    sessionId: req.sessionId,
    turnId: req.turnId,
    anthropicVersion: req.anthropicVersion,
    anthropicBeta: req.anthropicBeta,
  };

  const token = await tokenProvider.getToken();
  const first = await forwardAnthropicToKernel(deps.kernelBaseUrl, path, token, req.bodyText, deps.kernelTimeoutMs, headers);
  if (first.status !== 401) return first;

  deps.log.warn({ route: route.id, endpoint: req.endpoint }, 'kernel rejected app token with 401 — reminting and retrying once');
  tokenProvider.invalidate();
  const freshToken = await tokenProvider.getToken();
  return forwardAnthropicToKernel(deps.kernelBaseUrl, path, freshToken, req.bodyText, deps.kernelTimeoutMs, headers);
}

/** Break-glass: try the route's direct Anthropic endpoint, or surface the original kernel failure. */
async function attemptFallback(
  deps: HandleAnthropicDeps,
  route: ProviderRouteConfig,
  req: IncomingAnthropicRequest,
  reason: string,
): Promise<ProxyResponse> {
  const directApiKey = deps.resolveDirectApiKey(route);
  if (!route.directBaseUrl || !directApiKey) {
    deps.log.error({ route: route.id, endpoint: req.endpoint, reason }, 'kernel unavailable and no break-glass direct endpoint configured');
    return jsonError(
      502,
      'kernel_unavailable',
      `Kernel passthrough failed (${reason}) and no break-glass fallback is configured for '${route.id}'`,
    );
  }

  try {
    const direct = await forwardAnthropicDirect(
      route,
      directApiKey,
      kernelPath(req.endpoint),
      req.bodyText,
      deps.directTimeoutMs,
      { anthropicVersion: req.anthropicVersion, anthropicBeta: req.anthropicBeta },
    );
    deps.health.recordFallback();
    deps.log.warn({ route: route.id, endpoint: req.endpoint, reason, status: direct.status }, 'break-glass: fell back to direct Anthropic endpoint');
    return toProxyResponse(direct);
  } catch (err) {
    deps.health.recordFallback();
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.error({ route: route.id, endpoint: req.endpoint, reason, detail }, 'break-glass fallback itself failed');
    return jsonError(502, 'fallback_failed', `Kernel passthrough failed (${reason}) and the break-glass fallback also failed: ${detail}`);
  }
}
