export interface CloudflareZone { domain: string; zoneId: string }
export function cloudflareFormText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}
export interface DnsRecord {
  id: string; type: string; name: string; content: string; ttl: number;
  proxied?: boolean; proxiable?: boolean;
  priority?: number;
}
export interface CacheRule {
  id?: string; ref?: string; description: string; expression: string; action: 'set_cache_settings';
  enabled: boolean; action_parameters: {
    cache?: boolean;
    edge_ttl?: { mode: 'respect_origin' | 'bypass_by_default' | 'override_origin'; default?: number };
    browser_ttl?: { mode: 'respect_origin' | 'bypass_by_default' | 'override_origin'; default?: number };
  };
}
export interface CustomHostname {
  id: string; hostname: string; status?: string;
  ownership_verification?: unknown; ownership_verification_http?: unknown;
  ssl?: { status?: string; validation_records?: unknown; validation_errors?: unknown };
}
export interface CloudflareHistory {
  id: string; issuerDid: string; issuedAt: string;
  payload: { actorDid: string; onBehalfOf: string; zoneId: string;
    operation: string; phase: string; before: unknown; after: unknown };
  signature: unknown;
}

export function validCloudflareZone(zone: CloudflareZone): boolean {
  return /^[a-f0-9]{32}$/.test(zone.zoneId)
    && zone.domain === zone.domain.toLowerCase()
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(zone.domain);
}

export function cloudflareUrl(zone: CloudflareZone, resource: string): string {
  return `/cloudflare/api/zones/${zone.zoneId}/${resource}?domain=${encodeURIComponent(zone.domain)}`;
}

export function cloudflareFailure(status: number): string {
  if (status === 401) return 'Sign in as yourself to operate this zone.';
  if (status === 403) return 'This identity does not have the required live capability for this verified zone.';
  if (status === 409) return 'Zone credential or state is unavailable. Check Import credential, or reload and preview again.';
  return 'Cloudflare operation unavailable. Retry after checking access and zone configuration.';
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isDnsRecord(value: unknown): value is DnsRecord {
  return record(value) && ['id', 'type', 'name', 'content'].every((key) => typeof value[key] === 'string')
    && typeof value.ttl === 'number' && typeof value.proxied === 'boolean';
}
export function isCacheRule(value: unknown): value is CacheRule {
  return record(value) && typeof value.expression === 'string' && typeof value.enabled === 'boolean'
    && record(value.action_parameters) && value.action === 'set_cache_settings';
}
export function isCustomHostname(value: unknown): value is CustomHostname {
  return record(value) && typeof value.id === 'string' && typeof value.hostname === 'string'
    && (value.ssl === undefined || record(value.ssl));
}
export function isCloudflareHistory(value: unknown): value is CloudflareHistory {
  if (!record(value) || typeof value.id !== 'string' || !record(value.payload)) return false;
  const payload = value.payload;
  return ['actorDid', 'onBehalfOf', 'zoneId', 'operation', 'phase'].every((key) => typeof payload[key] === 'string');
}
export function cloudflareList<T>(value: unknown, key: string, guard: (item: unknown) => item is T): T[] {
  const list = record(value) ? value[key] : null;
  if (!Array.isArray(list) || !list.every(guard)) throw new Error('Invalid operation metadata');
  return list;
}
/** Provider/server error text is never displayed, thrown or logged. */
export async function cloudflareRequest<T>(zone: CloudflareZone, resource: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(cloudflareUrl(zone, resource), {
    method, credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(cloudflareFailure(response.status));
  return response.json() as Promise<T>;
}
