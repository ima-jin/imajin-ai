import { scopedRecords, type DnsProvider, type DnsRecord, type DnsSetupResult } from './types';

/** No network, credentials or claims of verification. SPF is a merge instruction. */
export class ManualDnsProvider implements DnsProvider {
  constructor(private readonly domain: string) {}

  apply(records: readonly DnsRecord[]): Promise<DnsSetupResult> {
    return Promise.resolve({
      mode: 'manual', status: 'action-required', records: scopedRecords(this.domain, records),
      instructions: [
        'Publish the records with your DNS provider; do not change MX or mailbox settings.',
        'For SPF, merge the required include into the existing v=spf1 TXT record before all; never publish a second SPF record or replace existing includes.',
        'DNS publication is not verification. Recheck domain ownership and mail verification after propagation.',
      ],
    });
  }
}
