import type { ProviderRouteConfig } from './types.js';

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
 * 422 client error (analogous to the kernel's own `NoModelSelectedError`)
 * rather than guessing a provider.
 */
export function resolveRoute(
  routes: readonly ProviderRouteConfig[],
  pathProviderId: string | undefined,
  model: string | undefined,
): ProviderRouteConfig | undefined {
  if (pathProviderId) {
    return routes.find((route) => route.id === pathProviderId);
  }
  if (!model) return undefined;
  return routes.find((route) => (route.modelPrefixes ?? []).some((prefix) => model.startsWith(prefix)));
}
