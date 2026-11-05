import { Resolver } from 'node:dns/promises';
import { mergeSpfInclude, publishableMailRecords, type MailDomainStatus, type MailDnsRecord } from './postal-domains';

const dns = new Resolver({ timeout: 3000, tries: 1 });
export type MailDomainGuidance = { records: MailDnsRecord[]; error: string | null };

/** Failed DNS is NOT absence of SPF: withhold SPF guidance instead of creating a second policy. */
export async function mailDomainGuidance(status: MailDomainStatus): Promise<MailDomainGuidance> {
  if (status.state === 'disabled') return { records: [], error: null };
  const records = publishableMailRecords(status);
  const spf = records.find(record => record.kind === 'spf');
  if (!spf) return { records, error: null };
  try {
    let txt: string[][];
    try {
      txt = await dns.resolveTxt(status.domain);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENODATA' && code !== 'ENOTFOUND') throw error;
      txt = [];
    }
    const policies = txt.map(chunks => chunks.join('')).filter(value => /^v=spf1(?:\s|$)/i.test(value));
    if (policies.length > 1 || !spf.include) throw new Error('Ambiguous SPF policy');
    const merged = mergeSpfInclude(policies[0] ?? null, spf.include);
    return { records: records.map(record => record === spf ? { ...record, value: merged } : record), error: null };
  } catch {
    return { records: records.filter(record => record.kind !== 'spf'), error: 'spf_lookup_unavailable' };
  }
}
