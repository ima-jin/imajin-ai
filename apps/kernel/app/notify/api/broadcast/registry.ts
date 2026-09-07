import { registryServiceUrl, hasRegistryServiceUrl } from '@imajin/config';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

// TODO(#538): These registry routes will be implemented by Agent 1.
// Stubbed here with clear fallback behavior.

/**
 * Fetch audience DIDs from registry for a scope.
 * TODO(#538): Registry /api/audience/:scope implemented by Agent 1.
 */
export async function fetchAudienceFromRegistry(
  scope: string,
  webhookSecret: string,
): Promise<string[]> {
  if (!hasRegistryServiceUrl()) {
    log.warn({}, 'REGISTRY_SERVICE_URL not set — cannot fetch audience from registry');
    return [];
  }
  try {
    const res = await fetch(`${registryServiceUrl()}/api/audience/${encodeURIComponent(scope)}?channel=email`, {
      headers: { 'x-webhook-secret': webhookSecret },
      cache: 'no-store',
    });
    if (!res.ok) {
      log.error({ status: res.status }, 'Registry audience fetch failed');
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.dids) ? data.dids : [];
  } catch (err) {
    log.error({ err: String(err) }, 'Registry audience fetch error');
    return [];
  }
}

/**
 * Check registry preferences for a DID + scope.
 * Returns true if the DID is eligible to receive marketing email for this scope.
 * TODO(#538): Registry /api/preferences/:did implemented by Agent 1.
 */
export async function checkRegistryPreferences(
  did: string,
  scope: string,
  webhookSecret: string,
): Promise<boolean> {
  if (!hasRegistryServiceUrl()) return true; // optimistic if registry not configured
  try {
    const res = await fetch(
      `${registryServiceUrl()}/api/preferences/${encodeURIComponent(did)}`,
      { headers: { 'x-webhook-secret': webhookSecret }, cache: 'no-store' },
    );
    if (!res.ok) return true; // default to eligible on registry error
    const prefs = await res.json();

    // Global marketing kill-switch
    if (prefs.globalMarketing === false) return false;

    // Per-scope interest check (if the row exists)
    const scopePrefs = (prefs.interests ?? []).find(
      (i: { scope: string }) => i.scope === scope,
    );
    if (scopePrefs) {
      if (scopePrefs.marketing === false) return false;
      if (scopePrefs.email === false) return false;
    }

    return true;
  } catch {
    return true; // optimistic on error
  }
}
