import { normalizeDomain } from '@/src/lib/domains/normalize';

/** Send-only: deliberately no MX, NS, address or mailbox-provider writes. */
export interface DnsRecord {
  type: 'TXT' | 'CNAME';
  name: string;
  content: string;
}

export interface DnsSetupResult {
  mode: 'manual' | 'automatic';
  records: DnsRecord[];
  instructions: string[];
  /** A successful write is NOT DNS propagation or Postal verification. */
  status: 'action-required' | 'written';
}

export interface DnsProvider {
  apply(records: readonly DnsRecord[]): Promise<DnsSetupResult>;
}

export type DnsProviderConfig = { provider: 'manual' } | { provider: 'cloudflare'; zoneId: string };

export class DnsError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'DnsError';
  }
}

/** Validate the complete plan before the first write, including runtime callers. */
export function scopedRecords(domain: string, records: readonly DnsRecord[]): DnsRecord[] {
  const scope = normalizeDomain(domain);
  if (records.length > 50) throw new DnsError('invalid_dns_records');
  const normalized = records.map((record) => {
    const name = record.name.toLowerCase().replace(/\.$/u, '');
    const labels = name.split('.');
    if (!['TXT', 'CNAME'].includes(record.type) || name.length > 253
      || !labels.every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u.test(label))
      || (name !== scope && !name.endsWith(`.${scope}`))
      || !record.content || record.content.length > 8192 || /[\r\n\0]/u.test(record.content)) {
      throw new DnsError('invalid_dns_records');
    }
    const content = record.type === 'CNAME' ? normalizeDomain(record.content) : record.content;
    if (record.type === 'CNAME' && (name === scope || name === content)) {
      throw new DnsError('invalid_dns_records');
    }
    return { type: record.type, name, content };
  });
  const unique = [...new Map(normalized.map((record) => [JSON.stringify(record), record])).values()];
  for (const record of unique) {
    const siblings = unique.filter((entry) => entry.name === record.name);
    if ((record.type === 'CNAME' && siblings.length > 1)
      || siblings.filter((entry) => /^v=spf1(?:\s|$)/iu.test(entry.content.trim())).length > 1) {
      throw new DnsError('conflicting_dns_plan');
    }
  }
  return unique;
}
