import { resolveVerifiedDomain } from '@/src/lib/domains/service';
import { getMailDomainStatus } from './postal-domains';

/** No request/env override: both independent authorities must still be valid. */
export async function isDomainMailReady(ownerDid: string, domain: string): Promise<boolean> {
  try {
    const status = await getMailDomainStatus(ownerDid, domain);
    if (status?.state !== 'verified' || !status.ownershipVerified || !status.dnsOk) return false;
    const binding = await resolveVerifiedDomain(domain);
    return binding?.zoneOwner === ownerDid;
  } catch {
    return false;
  }
}
