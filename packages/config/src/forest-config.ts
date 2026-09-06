import { getServiceUrl } from './services';

/**
 * Public forest-group (scope) config exposed by
 * `GET /api/forest/{groupDid}/config/public` on the profile service. Only
 * the field relevant to `.fair` fee-split calculation is modeled here — the
 * rest of the config (enabledServices, landingService, etc.) is a
 * community-settings concern, not a shared SDK concern.
 */
export interface ForestScopeConfig {
  /** Group's configured revenue-share fee, in basis points (0-500). Null if unset. */
  scopeFeeBps: number | null;
}

function profileBaseUrl(): string {
  // Like every other `*_SERVICE_URL`, this includes the service's path
  // prefix (`/profile`) — callers append only the endpoint path
  // (`/api/forest/...`). See #2046 (the equivalent REGISTRY_SERVICE_URL
  // fix) for why omitting the prefix here is the wrong default.
  if (process.env.PROFILE_SERVICE_URL) return process.env.PROFILE_SERVICE_URL;
  const mode = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
  const base = getServiceUrl('profile', mode) ?? 'http://localhost:3000';
  return `${base}/profile`;
}

/**
 * Fetch a forest group's public scope-fee config from the profile service
 * (`GET /api/forest/{groupDid}/config/public`, documented in
 * `apps/kernel/api-spec/profile.yaml`).
 *
 * Replaces raw `profile.forest_config` SQL reads that were duplicated
 * across coffee, learn, and market (audit item 9 of #1983, #2001). Returns
 * null on any failure — network error, non-2xx response — so callers can
 * fall back to the same `scopeFeeBps: null` default they used when the raw
 * SQL row was missing.
 */
export async function getForestScopeConfig(groupDid: string): Promise<ForestScopeConfig | null> {
  const url = `${profileBaseUrl()}/api/forest/${encodeURIComponent(groupDid)}/config/public`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[config] getForestScopeConfig: profile service returned ${res.status} for ${url}`);
      return null;
    }
    const data = (await res.json()) as { scopeFeeBps?: unknown };
    return { scopeFeeBps: typeof data?.scopeFeeBps === 'number' ? data.scopeFeeBps : null };
  } catch (err) {
    console.warn(`[config] getForestScopeConfig: fetch failed for ${url} — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
