/**
 * Server read for the /jin "Provision app" panel's list of provisioned apps
 * (#2745). Reuses the EXISTING `GET /api/apps/provision` (list mode,
 * `?status=succeeded`) — no new endpoint, no new authority. The route scopes
 * the list to the node operator and flags each app `claimed` once a claim
 * code for it has been redeemed.
 */

/** One succeeded provision, as returned by `GET /api/apps/provision?status=succeeded`. */
export interface ProvisionedApp {
  slug: string;
  appDid: string | null;
  repoUrl: string | null;
  /** True once a claim code for this app has been redeemed — Reissue is not offered then. */
  claimed: boolean;
}

export const PROVISIONED_APPS_URL = '/api/apps/provision?status=succeeded';

/**
 * Succeeded provisions, or an empty list when the read fails or the caller is not the operator —
 * the list is a convenience on top of the form, so a transient error must never break the panel.
 */
export async function fetchProvisionedApps(): Promise<ProvisionedApp[]> {
  try {
    const res = await fetch(PROVISIONED_APPS_URL, { credentials: 'include' });
    if (!res.ok) return [];
    const data = (await res.json()) as { provisions?: ProvisionedApp[] };
    return Array.isArray(data.provisions) ? data.provisions : [];
  } catch {
    return [];
  }
}
