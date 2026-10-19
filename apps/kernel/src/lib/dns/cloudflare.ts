import { normalizeDomain } from '@/src/lib/domains/normalize';
import { isSpf, mergeSpf } from './spf';
import { DnsError, scopedRecords, type DnsProvider, type DnsRecord, type DnsSetupResult } from './types';

interface CloudflareRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}
interface Envelope {
  success: boolean;
  result: unknown;
  result_info?: { total_pages: number };
}
interface Write {
  record: DnsRecord;
  id?: string;
  unchanged: boolean;
}

/** Cloudflare can return quoted TXT chunks; compare the logical TXT value. */
export function txtValue(content: string): string {
  if (!content.startsWith('"')) return content;
  const chunks = content.match(/"(?:[^"\\]|\\["\\])*"/gu);
  if (!chunks || chunks.join('') !== content.replace(/"\s+"/gu, '""')) {
    throw new DnsError('unsupported_txt_encoding');
  }
  return chunks.map((chunk) => chunk.slice(1, -1).replace(/\\(["\\])/gu, '$1')).join('');
}

function plan(record: DnsRecord, existing: CloudflareRecord[]): Write {
  if (existing.some((entry) => entry.type === 'NS')) throw new DnsError('dns_record_conflict');
  if (record.type === 'CNAME') {
    if (existing.length === 0) return { record, unchanged: false };
    if (existing.length !== 1 || existing[0].type !== 'CNAME'
      || normalizeDomain(existing[0].content) !== record.content) throw new DnsError('dns_record_conflict');
    // A mail CNAME must remain DNS-only, never an HTTP proxy.
    return { record, id: existing[0].id, unchanged: existing[0].proxied === false };
  }
  if (existing.some((entry) => entry.type === 'CNAME')) throw new DnsError('dns_record_conflict');
  const txt = existing.filter((entry) => entry.type === 'TXT');
  const spf = txt.filter((entry) => isSpf(txtValue(entry.content)));
  if (isSpf(record.content)) {
    if (spf.length > 1) throw new DnsError('ambiguous_spf');
    const current = spf[0];
    const content = mergeSpf(current ? txtValue(current.content) : undefined, record.content);
    return { record: { ...record, content }, id: current?.id, unchanged: Boolean(current && txtValue(current.content) === content) };
  }
  return { record, unchanged: txt.some((entry) => txtValue(entry.content) === record.content) };
}

/**
 * Server-only adapter. Caller obtains token exclusively from the domain vault
 * resolver. Native private storage prevents accidental inspection/serialization.
 */
export class CloudflareDnsProvider implements DnsProvider {
  #token: string;
  #domain: string;
  #zoneId: string;

  constructor(domain: string, zoneId: string, token: string) {
    this.#domain = normalizeDomain(domain);
    if (!/^[a-f0-9]{32}$/u.test(zoneId)) throw new DnsError('invalid_dns_zone');
    this.#zoneId = zoneId;
    this.#token = token;
  }

  private async request(path: string, method = 'GET', body?: unknown): Promise<Envelope> {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${this.#zoneId}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new DnsError('dns_provider_unavailable');
      const data = await response.json() as Envelope;
      if (data.success !== true) throw new DnsError('dns_provider_unavailable');
      return data;
    } catch {
      // No provider response text, request headers, exception cause or token.
      throw new DnsError('dns_provider_unavailable');
    }
  }

  private async list(name: string): Promise<CloudflareRecord[]> {
    const records: CloudflareRecord[] = [];
    for (let page = 1; page <= 10; page++) {
      const query = new URLSearchParams({ 'name.exact': name, per_page: '100', page: String(page) });
      const data = await this.request(`/dns_records?${query}`);
      if (!Array.isArray(data.result) || !Number.isInteger(data.result_info?.total_pages)
        || data.result_info!.total_pages < 1) {
        throw new DnsError('invalid_dns_provider_response');
      }
      for (const entry of data.result as CloudflareRecord[]) {
        if (!entry || !/^[a-f0-9]{32}$/u.test(entry.id) || entry.name !== name
          || typeof entry.content !== 'string' || typeof entry.type !== 'string') {
          throw new DnsError('invalid_dns_provider_response');
        }
        records.push(entry);
      }
      if (page >= data.result_info!.total_pages) return records;
    }
    throw new DnsError('dns_record_limit');
  }

  async apply(records: readonly DnsRecord[]): Promise<DnsSetupResult> {
    const scoped = scopedRecords(this.#domain, records);
    const zone = (await this.request('')).result as { name: string };
    if (typeof zone?.name !== 'string'
      || (this.#domain !== zone.name && !this.#domain.endsWith(`.${zone.name}`))) {
      throw new DnsError('dns_zone_mismatch');
    }
    const writes: Write[] = [];
    // Preflight every record before writing; don't half-apply a known conflict.
    for (const record of scoped) writes.push(plan(record, await this.list(record.name)));
    for (const write of writes) await this.write(write);
    return { mode: 'automatic', status: 'written', records: writes.map((write) => write.record),
      instructions: ['Recheck domain ownership and mail verification after DNS propagation.'] };
  }

  private async write(write: Write): Promise<void> {
    if (write.unchanged) return;
    if (write.id) {
      await this.request(`/dns_records/${write.id}`, 'PATCH', {
        content: write.record.content, ...(write.record.type === 'CNAME' ? { proxied: false } : {}),
      });
    } else {
      await this.request('/dns_records', 'POST', {
        ...write.record, ttl: 1, ...(write.record.type === 'CNAME' ? { proxied: false } : {}),
      });
    }
  }
}
