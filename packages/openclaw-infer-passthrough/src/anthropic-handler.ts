/**
 * Request orchestration for `POST /anthropic/v1/messages` and
 * `POST /anthropic/v1/messages/count_tokens` (imajin-ai#1959). A container
 * sets `ANTHROPIC_BASE_URL` to this shim's `/anthropic` prefix and
 * authenticates with `ANTHROPIC_API_KEY` (the Claude Agent SDK / Claude Code
 * CLI send it as `x-api-key` — their only auth header for a custom base
 * URL); this shim mints the short-lived kernel app-token in its place and
 * rides it as `x-api-key` on the kernel call, matching the kernel's own
 * `x-api-key` extension (`resolveInferenceAuth`, imajin-ai#1959).
 *
 * The kernel-then-break-glass decision flow itself (401 retry, 5xx/timeout
 * fallback, 4xx verbatim) lives in `dispatch.ts`, shared with
 * `handle-completions.ts`'s OpenAI-compatible sibling — this module only
 * builds the Anthropic-specific request pieces: which kernel/direct paths to
 * hit, and the `x-api-key`/`anthropic-version`/`anthropic-beta` headers.
 * Break-glass reuses the SAME `directBaseUrl`/`directApiKeyEnvVar` config
 * fields an OpenAI-compatible route uses — no separate config surface for
 * this wire format (see `config/routes.example.json`'s existing `"anthropic"`
 * entry).
 *
 * There is exactly one Anthropic route in the config table (`id: 'anthropic'`)
 * — unlike the OpenAI-compatible completions path there is no per-model
 * routing to do here: every `ANTHROPIC_BASE_URL` request speaks for the one
 * sealed Anthropic connector, so the caller looks the route up by that fixed
 * id rather than by path segment or `model` prefix.
 */
import { dispatchWithBreakGlass, jsonError, type ProxyResponse } from './dispatch.js';
import type { HealthTracker } from './health.js';
import type { Logger } from './logger.js';
import type { TokenSource } from './token-provider.js';
import { forwardAnthropicDirect, forwardAnthropicToKernel, type AnthropicPath } from './upstream.js';
import type { ProviderRouteConfig } from './types.js';

export type { ProxyResponse } from './dispatch.js';

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

  const path = kernelPath(req.endpoint);
  const headers = { sessionId: req.sessionId, turnId: req.turnId, anthropicVersion: req.anthropicVersion, anthropicBeta: req.anthropicBeta };

  return dispatchWithBreakGlass(
    { route, getTokenProvider: deps.getTokenProvider, resolveDirectApiKey: deps.resolveDirectApiKey, health: deps.health, log: deps.log },
    (token) => forwardAnthropicToKernel(deps.kernelBaseUrl, path, token, req.bodyText, deps.kernelTimeoutMs, headers),
    (directApiKey) =>
      forwardAnthropicDirect(route, directApiKey, path, req.bodyText, deps.directTimeoutMs, {
        anthropicVersion: req.anthropicVersion,
        anthropicBeta: req.anthropicBeta,
      }),
    { endpoint: req.endpoint },
  );
}
