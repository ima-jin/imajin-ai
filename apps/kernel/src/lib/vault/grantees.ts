/**
 * Active delegation grantees on a field, OTHER than the node's own
 * self-grant (#2450). Shared by `GET /api/vault/grantees/[field]` and the
 * fail-closed guards on `POST /api/vault/rotate` and `POST /api/vault/delete`
 * — the review on #2449 found the guard existed only in the browser (a raw
 * `POST /api/vault/delete` with no confirmation still returned 200), so the
 * count this module returns is what both the UI warning AND the route's own
 * 409 refusal are computed from, not two implementations that can drift.
 *
 * "Currently usable" excludes what a re-issue warning would mislead about:
 * an expired grant, or a one-time grant already consumed, can't be used
 * again regardless of what Rotate/Delete does, so it is not counted.
 */
import { and, eq, gt, isNull, ne, or } from 'drizzle-orm';
import { db, vaultDelegationGrants } from '@/src/db';

export interface VaultGrantee {
  grantedTo: string;
  purpose: string | null;
  oneTime: boolean;
  expiresAt: string | null;
}

export async function listOtherActiveGrantees(field: string, nodeDid: string): Promise<VaultGrantee[]> {
  const rows = await db
    .select({
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
    grantedTo: row.grantedTo,
    purpose: row.purpose,
    oneTime: row.oneTime,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }));
}
