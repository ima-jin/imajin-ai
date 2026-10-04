/**
 * Active delegation grantees on a field, OTHER than the node's own
 * self-grant (#2450). Shared by `GET /api/vault/grantees/[field]` and the
 * fail-closed guard on `POST /api/vault/rotate` — the count this module
 * returns is what both the UI warning AND the route's own 409 refusal are
 * computed from, not two implementations that can drift.
 *
 * "Currently usable" excludes what a re-issue warning would mislead about:
 * an expired grant, or a one-time grant already consumed, can't be used
 * again regardless of what Rotate does, so it is not counted.
 *
 * Rotate re-issues these grantees (#2450): `rotateAndStore` re-seals the
 * field and re-issues every external grant on the new key, carrying each
 * grant's expiry / one-time / purpose forward (`reissueFieldGrants`). The one
 * case it cannot is Tier 1 vault custody — the node holds no owner key to sign
 * a replacement grant — so there the guard stays fail-closed and the rotate is
 * refused while grantees exist. `getRotateGranteeGuard` is the single place
 * that decides this — the route's 409 and the dialog both read its result.
 */
import { and, eq, gt, isNull, ne, or } from 'drizzle-orm';
import { db, vaultDelegationGrants } from '@/src/db';
import { isVaultTier1 } from './sealing';

export interface VaultGrantee {
  grantId: string;
  grantedTo: string;
  purpose: string | null;
  oneTime: boolean;
  expiresAt: string | null;
}

export async function listOtherActiveGrantees(field: string, nodeDid: string): Promise<VaultGrantee[]> {
  const rows = await db
    .select({
      grantId: vaultDelegationGrants.id,
      grantedTo: vaultDelegationGrants.grantedTo,
      purpose: vaultDelegationGrants.purpose,
      oneTime: vaultDelegationGrants.oneTime,
      expiresAt: vaultDelegationGrants.expiresAt,
    })
    .from(vaultDelegationGrants)
    .where(
      and(
        eq(vaultDelegationGrants.field, field),
        eq(vaultDelegationGrants.status, 'active'),
        ne(vaultDelegationGrants.grantedTo, nodeDid),
        isNull(vaultDelegationGrants.consumedAt),
        or(isNull(vaultDelegationGrants.expiresAt), gt(vaultDelegationGrants.expiresAt, new Date())),
      ),
    );

  return rows.map((row) => ({
    grantId: row.grantId,
    grantedTo: row.grantedTo,
    purpose: row.purpose,
    oneTime: row.oneTime,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }));
}

export interface RotateGranteeGuard {
  /** Every other active grantee on the field — what a rotate re-issues (or, under Tier 1, would strand). */
  grantees: VaultGrantee[];
  /** True when rotating this field re-issues its grantees (Tier 0). False means rotate must be refused while `grantees` is non-empty. */
  reissuedOnRotate: boolean;
}

/**
 * What the rotate guard (route 409 + dialog) should act on for `field`.
 * Tier 0 re-issues every grantee itself, so nothing blocks. Tier 1 cannot
 * re-issue, so a field with grantees is refused (fail-closed, #2450).
 */
export async function getRotateGranteeGuard(field: string, nodeDid: string): Promise<RotateGranteeGuard> {
  return { grantees: await listOtherActiveGrantees(field, nodeDid), reissuedOnRotate: !isVaultTier1() };
}
