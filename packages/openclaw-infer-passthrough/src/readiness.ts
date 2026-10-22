import type { ProviderRouteConfig } from './types.js';
import type { TokenSource } from './token-provider.js';

/** A probe shares the request cache, but never falls back to a direct provider. */
export async function checkRouteMints(
  routes: ProviderRouteConfig[],
  getTokenProvider: (routeId: string) => TokenSource,
) {
  const results = await Promise.all(routes.map(async (route) => {
    try {
      await getTokenProvider(route.id).getToken();
      return { route: route.id, ok: true };
    } catch {
      // Do not echo kernel bodies, signing errors or credentials into health/logs.
      return {
        route: route.id,
        ok: false,
        message: 'Unable to mint a live app token; check app credentials and kernel connectivity, then re-grant on /jin → Grants',
      };
    }
  }));
  return { ok: results.length > 0 && results.every((route) => route.ok), routes: results };
}
