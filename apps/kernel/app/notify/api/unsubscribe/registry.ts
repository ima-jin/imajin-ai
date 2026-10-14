import { notifyRegistryKey } from '@/src/lib/notify/service-auth';
import { registryServiceUrl, hasRegistryServiceUrl } from '@imajin/config';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * Update registry preference to opt-out of marketing for this scope.
 */
export async function updateRegistryPreference(did: string, scope: string): Promise<void> {
  if (!hasRegistryServiceUrl()) {
    log.warn({}, 'REGISTRY_SERVICE_URL not set — cannot update registry preference');
    return;
  }
  try {
    const internalKey = await notifyRegistryKey();
    const res = await fetch(
      `${registryServiceUrl()}/api/preferences/${encodeURIComponent(did)}/interests/${encodeURIComponent(scope)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${internalKey}`,
        },
        body: JSON.stringify({ marketing: false, email: false }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error({ status: res.status, text }, 'Registry update failed');
    }
  } catch (err) {
    log.error({ err: String(err) }, 'Registry update error');
  }
}
