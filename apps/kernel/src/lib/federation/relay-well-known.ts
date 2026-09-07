import { createLogger } from '@imajin/logger';
import { registryServiceUrl } from '@imajin/config';

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
 * Uses the shared `registryServiceUrl()` resolver (#2061) so there is
 * exactly one place the registry base URL — including its `/registry`
 * path prefix (#2046) — is computed. Returns null on any failure (network
 * error, non-2xx response), logging a warning with the URL actually hit
 * (no secrets) so a misconfigured prefix is visible instead of failing
 * silently.
 */
export async function getRelayWellKnown(): Promise<RelayWellKnown | null> {
  const url = `${registryServiceUrl()}/relay/.well-known/dfos-relay`;
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
