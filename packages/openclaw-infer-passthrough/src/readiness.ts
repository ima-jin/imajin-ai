import type { ProviderRouteConfig } from './types.js';
import type { TokenSource } from './token-provider.js';
import { NoLiveGrantError, TokenMintError } from './token-provider.js';

function mintFailure(error: unknown) {
  if (error instanceof NoLiveGrantError) {
    return 'No live grant; re-grant on /jin → Grants';
  }
  if (error instanceof TokenMintError && error.code === 'app_not_registered') {
    return 'Audience is not a registered active kernel app; register the audience before using this route';
  }
  if (error instanceof TokenMintError && error.status === 401) {
    return 'App authentication failed; check the app identity and signing credentials';
  }
  if (error instanceof TokenMintError && error.status === 403) {
    return 'Kernel refused the mint; check app status, audience policy and granted scopes';
  }
  return 'Unable to mint a live app token; check app configuration and kernel connectivity';
}

/** A probe shares the request cache, but never falls back to a direct provider. */
export async function checkRouteMints(
  routes: readonly ProviderRouteConfig[],
  getTokenProvider: (routeId: string) => TokenSource,
) {
  const results = await Promise.all(routes.map(async (route) => {
    try {
      await getTokenProvider(route.id).getToken();
      return { route: route.id, ok: true };
    } catch (error) {
      // Do not echo kernel bodies, signing errors or credentials into health/logs.
      const skipped = route.id === 'mcp' && error instanceof TokenMintError &&
        error.status === 403 && error.code === 'app_not_registered';
      return {
        route: route.id,
        ok: skipped,
        ...(skipped ? { skipped: true } : {}),
        message: mintFailure(error),
      };
    }
  }));
  return { ok: results.length > 0 && results.every((route) => route.ok), routes: results };
}
