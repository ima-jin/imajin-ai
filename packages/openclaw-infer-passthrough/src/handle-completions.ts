/**
 * Request orchestration for `POST /v1/chat/completions` and
 * `POST /:providerId/v1/chat/completions` (imajin-ai#1926).
 *
 * Deliberately decoupled from `node:http` so it can be exercised directly in
 * tests without a real socket (see `tests/handle-completions.test.ts`) — the
 * HTTP adapter lives in `server.ts`. The kernel-then-break-glass decision
 * flow itself (401 retry, 5xx/timeout fallback, 4xx verbatim) lives in
 * `dispatch.ts`, shared with `anthropic-handler.ts` (imajin-ai#1959) — this
 * module only builds the OpenAI-compatible-specific request/response pieces:
 * route resolution by path segment or `model`, and the two upstream calls.
 */
import { dispatchWithBreakGlass, jsonError, type ProxyResponse } from './dispatch.js';
import type { HealthTracker } from './health.js';
import type { Logger } from './logger.js';
import { resolveRoute } from './router.js';
import type { TokenSource } from './token-provider.js';
import { forwardDirect, forwardToKernel } from './upstream.js';
import type { ProviderRouteConfig } from './types.js';

export type { ProxyResponse } from './dispatch.js';

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

  return dispatchWithBreakGlass(
    { route, getTokenProvider: deps.getTokenProvider, resolveDirectApiKey: deps.resolveDirectApiKey, health: deps.health, log: deps.log },
    (token) =>
      forwardToKernel(deps.kernelBaseUrl, token, req.bodyText, deps.kernelTimeoutMs, {
        sessionId: req.sessionId,
        turnId: req.turnId,
      }),
    (directApiKey) => forwardDirect(route, directApiKey, req.bodyText, deps.directTimeoutMs),
  );
}
