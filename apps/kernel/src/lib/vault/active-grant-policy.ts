import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db, vaultDelegationGrants } from '@/src/db';

/** The same lifecycle selector used by credential loading, without reading key material. */
export function activeVaultGrantWhere(field: string, granteeDid: string) {
  return and(
    eq(vaultDelegationGrants.grantedTo, granteeDid),
    eq(vaultDelegationGrants.field, field),
    eq(vaultDelegationGrants.status, 'active'),
    or(isNull(vaultDelegationGrants.expiresAt), gt(vaultDelegationGrants.expiresAt, new Date())),
  );
}

export async function hasActiveVaultGrant(field: string, granteeDid: string) {
  const [grant] = await db.select({ id: vaultDelegationGrants.id }).from(vaultDelegationGrants)
    .where(activeVaultGrantWhere(field, granteeDid)).limit(1);
  return !!grant;
}
