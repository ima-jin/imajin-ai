import type { ProviderRouteConfig } from './types.js';

/** A request named a provider route that is not in the routes config (imajin-ai#2453). */
export class UnknownRouteError extends Error {
  constructor(routeId: string) {
    super(`Unknown route '${routeId}'`);
    this.name = 'UnknownRouteError';
  }
}

/**
 * The generic OpenAI-compatible seat. OpenClaw's `baseUrl` for the kernel
 * passthrough is `/openai/v1`, and every model — `grok-4` included — is
 * requested through it. A model whose prefix belongs to another route
 * (`grok-` → `xai`) must still reach that route's attestation and
 * break-glass key (imajin-ai#2453), so on this id the model wins.
 */
export const OPENAI_ALIAS_ROUTE_ID = 'openai';

/**
 * Resolve which provider route a request targets.
 *
 * Path-prefixed requests (`POST /:providerId/v1/chat/completions`) name
 * their route explicitly — the preferred wiring, since OpenClaw registers
 * one custom-provider entry per upstream anyway. The unprefixed
 * `POST /v1/chat/completions` path falls back to matching `body.model`
 * against each route's `modelPrefixes`, in config order (first match wins).
 *
 * Returns `undefined` when no route matches — the caller surfaces this as a
 * 404 (unknown model/route) rather than guessing a provider.
 */
export function resolveRoute(
  routes: readonly ProviderRouteConfig[],
  pathProviderId: string | undefined,
  model: string | undefined,
): ProviderRouteConfig | undefined {
  const byModel = model
    ? routes.find((route) => (route.modelPrefixes ?? []).some((prefix) => model.startsWith(prefix)))
    : undefined;
  if (!pathProviderId) return byModel;
  const pathRoute = routes.find((route) => route.id === pathProviderId);
  if (pathProviderId !== OPENAI_ALIAS_ROUTE_ID) return pathRoute;
  return byModel ?? pathRoute;
}
