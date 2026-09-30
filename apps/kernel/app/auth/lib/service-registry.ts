/**
 * Kernel-native service identity for `<ServiceEmbed>` (#2275) and the hub's
 * dynamic `/auth/[app]` route. Deliberately framework-agnostic (no 'use
 * client', no server-only imports) so it can be imported from the client
 * component AND server-side route code without either side re-declaring
 * anything.
 *
 * #2425 send-back: this module used to also carry a hard-coded, 6-app-only
 * `SERVICE_URLS`/`KNOWN_SERVICES` map for the apps `registry.apps` now owns
 * (coffee/dykil/links/learn/events/market) — every literal app slug has
 * been removed from this file. A non-kernel-native embed's base URL now
 * always comes from the CALLER, resolved from the registry row's own slug
 * via `buildPublicUrl` (`@imajin/config`) — see
 * `apps/kernel/app/auth/[app]/page.tsx` and the health route, which also
 * checks slug validity against `registry.apps` directly (see
 * `src/lib/kernel/app-nav.ts`'s `isActiveRegistryAppSlug`) instead of a
 * static set here.
 */

/** Services that live inside the kernel process itself — no separate origin, no health check needed, and never pruned from the registry (see `src/lib/kernel/app-nav.ts`'s docblock). */
const KERNEL_NATIVE_SERVICES = new Set(['pay', 'media']);

/** Kernel-native services use their own in-process path, not a remote `/dashboard`. */
const KERNEL_SERVICE_PATHS: Record<string, string> = {
  pay: '/pay',
  media: '/media',
};

export function isKernelNativeService(service: string): boolean {
  return KERNEL_NATIVE_SERVICES.has(service);
}

function getServicePath(service: string): string {
  return KERNEL_SERVICE_PATHS[service] ?? '/dashboard';
}

/**
 * Build the iframe `src` for a service embed, scoped to the given
 * delegated/effective DID. `baseUrl` (#2425) is the registry-resolved
 * origin for this service — omitted (relative src, resolved by the browser
 * against the current page) only for kernel-native services, which always
 * embed same-origin.
 */
export function buildEmbedSrc(service: string, did: string, baseUrl?: string): string {
  const path = getServicePath(service);
  const suffix = `${path}?embed=hub&did=${encodeURIComponent(did)}`;
  return baseUrl ? `${baseUrl}${suffix}` : suffix;
}
