/** Public metadata only. Resource authority is always scoped to the zone DID. */
export const CLOUDFLARE_CAPABILITIES = [
  'cloudflare:read', 'cloudflare:dns', 'cloudflare:cache',
  'cloudflare:ssl', 'cloudflare:custom-hostnames',
] as const;
export type CloudflareCapability = typeof CLOUDFLARE_CAPABILITIES[number];
export function isCloudflarePurpose(value: unknown): value is string {
  return typeof value === 'string' && (value === 'dns.cloudflare' || value.startsWith('dns.cloudflare:'));
}
export interface CloudflareImport {
  domain: string;
  zoneId: string;
  granteeDid: string;
  capabilities: CloudflareCapability[];
}

export function isCloudflareZoneAudience(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const audience = value as Record<string, unknown>;
  return audience.type === 'dids' && Array.isArray(audience.values) && audience.values.length === 1
    && typeof audience.values[0] === 'string' && /^did:imajin:cloudflare-[a-f0-9]{32}$/.test(audience.values[0]);
}

export function isCloudflareZoneId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

export function cloudflarePurpose(zoneId: string): string {
  if (!isCloudflareZoneId(zoneId)) throw new Error('Invalid Cloudflare zone');
  return `dns.cloudflare:${zoneId}`;
}

export function cloudflareZoneDid(zoneId: string): string {
  if (!isCloudflareZoneId(zoneId)) throw new Error('Invalid Cloudflare zone');
  return `did:imajin:cloudflare-${zoneId}`;
}

export function isCloudflareImport(value: unknown): value is CloudflareImport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => ['domain', 'zoneId', 'granteeDid', 'capabilities'].includes(key))
    && isCloudflareZoneId(input.zoneId)
    && typeof input.domain === 'string' && input.domain.length <= 253
    && input.domain.split('.').length >= 2
    && input.domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && !/^\d+$/.test(input.domain.split('.').at(-1)!)
    && typeof input.granteeDid === 'string' && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(input.granteeDid)
    && Array.isArray(input.capabilities) && input.capabilities.length > 0
    && input.capabilities.length <= CLOUDFLARE_CAPABILITIES.length
    && new Set(input.capabilities).size === input.capabilities.length
    && input.capabilities.every(capability => CLOUDFLARE_CAPABILITIES.includes(capability));
}
