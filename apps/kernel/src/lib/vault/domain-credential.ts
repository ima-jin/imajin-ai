import { resolveVerifiedDomain } from '@/src/lib/domains/service';
import { DomainError } from '@/src/lib/domains/normalize';
import { fetchPurposeCredential } from './purpose-credential';

/** Server-only secret resolver. Never return this value from public evidence APIs. */
export async function resolveDomainCredential(domain: string, granteeDid: string, purpose: string): Promise<string> {
  const binding = await resolveVerifiedDomain(domain);
  if (!binding) throw new DomainError('domain_not_verified', 'Verified domain binding required', 403);
  return fetchPurposeCredential(binding.zoneOwner, granteeDid, purpose);
}
