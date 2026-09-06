import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface RelayWellKnown {
  did: string;
  protocol: string;
  version: string;
  capabilities: Record<string, boolean>;
  profile: string;
}

/**
 * Fetch the local relay's `.well-known/dfos-relay` document for the
 * Federation admin page.
 *
 * REGISTRY_SERVICE_URL includes the `/registry` path prefix like every
 * other `*_SERVICE_URL` (#2046) — the fallback below matches that
 * convention so this doesn't double-prefix to `/registry/registry/...`
 * when the env var is unset. Returns null on any failure (network error,
 * non-2xx response), logging a warning with the URL actually hit (no
 * secrets) so a misconfigured prefix is visible instead of failing
 * silently.
 */
export async function getRelayWellKnown(): Promise<RelayWellKnown | null> {
  const registryBaseUrl =
    process.env.REGISTRY_SERVICE_URL || `http://localhost:${process.env.PORT || 3000}/registry`;
  const url = `${registryBaseUrl}/relay/.well-known/dfos-relay`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      log.warn({ url, status: res.status }, '[FEDERATION] getRelayWellKnown: non-2xx response — check REGISTRY_SERVICE_URL');
      return null;
    }
    return (await res.json()) as RelayWellKnown;
  } catch (err) {
    log.warn({ url, err: String(err) }, '[FEDERATION] getRelayWellKnown: fetch failed');
    return null;
  }
}
