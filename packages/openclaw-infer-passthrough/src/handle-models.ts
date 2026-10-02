/**
 * Request orchestration for `GET /openai/v1/models` (imajin-ai#2201).
 *
 * Mints (or reuses) the SAME kind of route token the OpenAI-compatible
 * completions path uses (`getTokenProvider('openai')`), retries once with a
 * freshly-minted token on a 401 (same rule `dispatch.ts`'s
 * `attemptKernelCall` applies to completions), and forwards the kernel's
 * `GET /infer/v1/models/usable` body back unchanged. No break-glass fallback:
 * unlike a completions call, there is no direct-provider equivalent that
 * would return the SAME thing (the principal's sealed connectors) — a
 * kernel outage here just means model discovery is briefly unavailable, not
 * a chat-completions site.
 */
import { jsonError, toProxyResponse, type ProxyResponse } from './dispatch.js';
import { OPENAI_ALIAS_ROUTE_ID } from './router.js';
import type { TokenSource } from './token-provider.js';
import { forwardModelsToKernel } from './upstream.js';
import type { ProviderRouteConfig } from './types.js';

export interface HandleModelsDeps {
  /** Configured routes. Omitted → the 'openai' seat is assumed (pre-#2453 behaviour). */
  routes?: readonly ProviderRouteConfig[];
  kernelBaseUrl: string;
  kernelTimeoutMs: number;
  getTokenProvider(routeId: string): TokenSource;
}

/** Routes whose token cannot list models: `mcp` is audience-bound/unnarrowed, `anthropic` serves a different (Anthropic-format) catalog. */
const NON_MODELS_ROUTE_IDS = new Set(['mcp', 'anthropic']);

/**
 * Pick the route whose app token authorizes the listing. The kernel's list is
 * principal-wide (every usable sealed connector), so any inference route's
 * token returns the same answer: prefer the named one (default `openai`, the
 * seat OpenClaw's `baseUrl` points at), else any other inference route so a
 * config without an explicit `openai` entry still answers rather than 404s
 * or 500s (imajin-ai#2453).
 */
function pickModelsRouteId(routes: readonly ProviderRouteConfig[] | undefined, providerId: string | undefined): string | undefined {
  const wanted = providerId ?? OPENAI_ALIAS_ROUTE_ID;
  if (!routes) return wanted;
  if (NON_MODELS_ROUTE_IDS.has(wanted)) return undefined;
  if (routes.some((route) => route.id === wanted)) return wanted;
  if (wanted !== OPENAI_ALIAS_ROUTE_ID) return undefined;
  return routes.find((route) => !NON_MODELS_ROUTE_IDS.has(route.id))?.id;
}

export async function handleModels(deps: HandleModelsDeps, providerId?: string): Promise<ProxyResponse> {
  const routeId = pickModelsRouteId(deps.routes, providerId);
  if (!routeId) {
    return providerId && providerId !== OPENAI_ALIAS_ROUTE_ID
      ? jsonError(404, 'route_not_found', `No configured route '${providerId}' serves model discovery`)
      : jsonError(422, 'no_route_configured', 'No inference route configured in INFER_PROXY_ROUTES_CONFIG for model discovery');
  }
  const tokenProvider = deps.getTokenProvider(routeId);

  const token = await tokenProvider.getToken();
  const first = await forwardModelsToKernel(deps.kernelBaseUrl, token, deps.kernelTimeoutMs);
  if (first.status !== 401) return toProxyResponse(first);

  tokenProvider.invalidate();
  const freshToken = await tokenProvider.getToken();
  const retried = await forwardModelsToKernel(deps.kernelBaseUrl, freshToken, deps.kernelTimeoutMs);
  return toProxyResponse(retried);
}
