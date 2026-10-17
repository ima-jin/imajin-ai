import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db, vaultDelegationGrants } from '@/src/db';
import { fetchGrantSecret } from '@/src/lib/vault';
import { DomainError } from '@/src/lib/domains/normalize';

/** Resolve only an unambiguous, active, subject/purpose/grantee-bound grant. */
export async function fetchPurposeCredential(subject: string, granteeDid: string, purpose: string): Promise<string> {
  if (!subject || !granteeDid || !purpose) {
    throw new DomainError('credential_unavailable', 'A scoped vault grant is required', 403);
  }
  const grants = await db.select({ id: vaultDelegationGrants.id }).from(vaultDelegationGrants)
    .where(and(
      eq(vaultDelegationGrants.subject, subject),
      eq(vaultDelegationGrants.grantedTo, granteeDid),
      eq(vaultDelegationGrants.purpose, purpose),
      eq(vaultDelegationGrants.status, 'active'),
      or(isNull(vaultDelegationGrants.expiresAt), gt(vaultDelegationGrants.expiresAt, new Date())),
      or(eq(vaultDelegationGrants.oneTime, false), isNull(vaultDelegationGrants.consumedAt)),
    )).limit(2);
  if (grants.length !== 1) {
    throw new DomainError('credential_unavailable', 'No unambiguous active scoped vault grant', 403);
  }
  const result = await fetchGrantSecret({ grantId: grants[0].id, granteeDid });
  if (result.status !== 'ok' || result.grant.subject !== subject
    || result.grant.purpose !== purpose || result.grant.grantedTo !== granteeDid) {
    throw new DomainError('credential_unavailable', 'Scoped vault grant is unavailable', 403);
  }
  return result.value;
}
