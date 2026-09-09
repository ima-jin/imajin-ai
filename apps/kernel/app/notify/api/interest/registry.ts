import { registryServiceUrl, hasRegistryServiceUrl } from '@imajin/config';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * Fetch the scope that an attestation type maps to.
 *
 * Returns the scope string, or null if no match found.
 */
export async function resolveScopeForAttestation(
  attestationType: string,
  webhookSecret: string,
): Promise<string | null> {
  if (!hasRegistryServiceUrl()) {
    log.warn({ attestationType }, 'REGISTRY_SERVICE_URL not set — cannot resolve scope');
    return null;
  }
  try {
    // Fetch full interest catalog and find matching scope
    const res = await fetch(`${registryServiceUrl()}/api/interests`, {
      headers: { 'x-webhook-secret': webhookSecret },
      cache: 'no-store',
    });
    if (!res.ok) {
      log.error({ status: res.status }, 'Registry interests fetch failed');
      return null;
    }
    const data = await res.json();
    const interests: { scope: string; triggers: string[] }[] = data.interests ?? [];
    const match = interests.find((i) => i.triggers?.includes(attestationType));
    return match?.scope ?? null;
  } catch (err) {
    log.error({ err: String(err) }, 'Scope resolution error');
    return null;
  }
}

/**
 * Check whether a did_interests row already exists for DID + scope.
 */
export async function didInterestExists(
  did: string,
  scope: string,
  webhookSecret: string,
): Promise<boolean> {
  if (!hasRegistryServiceUrl()) return false;
  try {
    const res = await fetch(
      `${registryServiceUrl()}/api/preferences/${encodeURIComponent(did)}`,
      { headers: { 'x-webhook-secret': webhookSecret }, cache: 'no-store' },
    );
    if (!res.ok) return false;
    const prefs = await res.json();
    const interests: { scope: string }[] = prefs.interests ?? [];
    return interests.some((i) => i.scope === scope);
  } catch {
    return false;
  }
}

/**
 * Create a did_interests row via registry internal API.
 * Channels enabled/disabled based on DID's auto_subscribe preference.
 */
export async function createDidInterest(
  did: string,
  scope: string,
  attestationType: string,
  webhookSecret: string,
): Promise<void> {
  if (!hasRegistryServiceUrl()) {
    log.warn({}, 'REGISTRY_SERVICE_URL not set — cannot create did_interest');
    return;
  }
  try {
    const res = await fetch(
      `${registryServiceUrl()}/api/preferences/${encodeURIComponent(did)}/interests/${encodeURIComponent(scope)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': webhookSecret,
        },
        body: JSON.stringify({ createdByAttestation: attestationType }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error({ status: res.status, text }, 'Registry create did_interest failed');
    }
  } catch (err) {
    log.error({ err: String(err) }, 'Create did_interest error');
  }
}
