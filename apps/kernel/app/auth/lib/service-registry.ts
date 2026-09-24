/**
 * Single source of truth for the userspace/kernel-native service URLs the hub
 * embeds via `<ServiceEmbed>` (#2275). Deliberately framework-agnostic (no
 * 'use client', no server-only imports) so it can be imported from the
 * client component AND the server-side health-check route without either
 * side re-declaring the map.
 */

/** Services that live inside the kernel process itself — no separate origin, no health check needed. */
const KERNEL_NATIVE_SERVICES = new Set(['pay', 'media']);

const SERVICE_URLS: Record<string, string> = {
  events: process.env.NEXT_PUBLIC_EVENTS_URL ?? '',
  market: process.env.NEXT_PUBLIC_MARKET_URL ?? '',
  coffee: process.env.NEXT_PUBLIC_COFFEE_URL ?? '',
  dykil: process.env.NEXT_PUBLIC_DYKIL_URL ?? '',
  learn: process.env.NEXT_PUBLIC_LEARN_URL ?? '',
  links: process.env.NEXT_PUBLIC_LINKS_URL ?? '',
  pay: '',
  media: '',
};

/** Kernel-native services use their own in-process path, not a remote `/dashboard`. */
const KERNEL_SERVICE_PATHS: Record<string, string> = {
  pay: '/pay',
  media: '/media',
};

export const KNOWN_SERVICES = new Set(Object.keys(SERVICE_URLS));

export function isKernelNativeService(service: string): boolean {
  return KERNEL_NATIVE_SERVICES.has(service);
}

/** Base origin for a service, or '' when unconfigured (local dev) or kernel-native (same origin). */
export function getServiceBaseUrl(service: string): string {
  return SERVICE_URLS[service] ?? '';
}

function getServicePath(service: string): string {
  return KERNEL_SERVICE_PATHS[service] ?? '/dashboard';
}

/** Build the iframe `src` for a service embed, scoped to the given delegated/effective DID. */
export function buildEmbedSrc(service: string, did: string): string {
  const baseUrl = getServiceBaseUrl(service);
  const path = getServicePath(service);
  const suffix = `${path}?embed=hub&did=${encodeURIComponent(did)}`;
  return baseUrl ? `${baseUrl}${suffix}` : suffix;
}
