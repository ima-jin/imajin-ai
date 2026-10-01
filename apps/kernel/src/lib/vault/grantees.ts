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
 * Exemption: `internal-secret:*` fields. Their rotate path
 * (`rotateInternalSecret`, #2446) already re-issues every external grantee on
 * the new key, so there is nothing to warn about or confirm.
 * `getRotateGranteeGuard` is the single place that decides this — the route's
 * 409 and the dialog's warning/typed-confirm both read its result.
 */
import { and, eq, gt, isNull, ne, or } from 'drizzle-orm';
import { db, vaultDelegationGrants } from '@/src/db';
import { isInternalSecretField } from './internal-secret';

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
  /** Grantees a rotate would strand — always empty when the rotate path re-issues them. */
  grantees: VaultGrantee[];
  /** True when rotating this field re-issues its grantees automatically (guard does not apply). */
  reissuedOnRotate: boolean;
}

/**
 * What the rotate guard (route 409 + dialog) should act on for `field`.
 * Fail-closed for every field except `internal-secret:*`, which re-issues its
 * external grantees itself (#2446) and so is exempt (#2450, ruling 2026-09-30).
 */
export async function getRotateGranteeGuard(field: string, nodeDid: string): Promise<RotateGranteeGuard> {
  if (isInternalSecretField(field)) {
    return { grantees: [], reissuedOnRotate: true };
  }
  return { grantees: await listOtherActiveGrantees(field, nodeDid), reissuedOnRotate: false };
}
