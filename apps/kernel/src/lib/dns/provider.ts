import { resolveDomainCredential } from '@/src/lib/vault/domain-credential';
import { DomainError, normalizeDomain } from '@/src/lib/domains/normalize';
import { CloudflareDnsProvider } from './cloudflare';
import { ManualDnsProvider } from './manual';
import { DnsError, scopedRecords, type DnsProvider, type DnsProviderConfig, type DnsRecord, type DnsSetupResult } from './types';

/** Shared purpose with the domain credential contract used by #2895. */
export const CLOUDFLARE_DNS_PURPOSE = 'dns.cloudflare';
const DEFAULT_DNS_PROVIDER: DnsProviderConfig = { provider: 'manual' };
class VaultCloudflareProvider implements DnsProvider {
  constructor(private readonly domain: string, private readonly granteeDid: string, private readonly zoneId: string) {}

  async apply(records: readonly DnsRecord[]): Promise<DnsSetupResult> {
    const scoped = scopedRecords(this.domain, records);
    let token: string;
    try {
      // Recheck verified ownership and grant lifecycle on EVERY operation.
      token = await resolveDomainCredential(this.domain, this.granteeDid, CLOUDFLARE_DNS_PURPOSE);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'credential_unavailable') {
        return new ManualDnsProvider(this.domain).apply(scoped);
      }
      throw new DnsError('dns_credential_unavailable');
    }
    return new CloudflareDnsProvider(this.domain, this.zoneId, token).apply(scoped);
  }
}

/**
 * Internal seam, not an authorization endpoint. A future settings/provisioning
 * caller must first enforce owner/admin auth and delegation policy. Config is
 * identifiers only; no token input, raw unseal, env fallback or secret response.
 */
export function resolveDnsProvider(
  domain: string, granteeDid: string, config: DnsProviderConfig = DEFAULT_DNS_PROVIDER,
): DnsProvider {
  const normalized = normalizeDomain(domain);
  if (config.provider === 'manual') return new ManualDnsProvider(normalized);
  if (config.provider !== 'cloudflare' || !/^[a-f0-9]{32}$/u.test(config.zoneId)) {
    throw new DnsError('invalid_dns_provider');
  }
  return new VaultCloudflareProvider(normalized, granteeDid, config.zoneId);
}
