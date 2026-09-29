import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gt, isNull, ne, or } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants } from '@/src/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/**
 * GET /api/vault/grantees/[field] (#2450 step 1) — every currently-usable
 * delegation grant on `field` OTHER than the node's own self-grant, so the
 * admin panel's Rotate and Delete dialogs can warn an operator BEFORE they
 * act: rotating or deleting a field re-seals or tombstones it under the
 * node's own custody, but does nothing to any other DID's existing grant —
 * that grantee's copy of the wrapped key still points at the OLD sealed
 * material, so its next fetch silently fails to decrypt (#2446/#2448/#2450).
 *
 * "Currently usable" excludes what a re-issue warning would mislead about:
 * an expired grant, or a one-time grant already consumed, can't be used
 * again regardless of what Rotate/Delete does, so it is not counted.
 *
 * Read-only — this route never re-issues anything itself (#2450 step 2,
 * generalizing #2448's re-issue to every delegation-grant field, is
 * deliberately separate follow-up work).
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ field: string }> }) {
  const params = await props.params;
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { field } = params;

  try {
    const identity = getNodeSigningIdentity();

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
          ne(vaultDelegationGrants.grantedTo, identity.senderDid),
          isNull(vaultDelegationGrants.consumedAt),
          or(isNull(vaultDelegationGrants.expiresAt), gt(vaultDelegationGrants.expiresAt, new Date())),
        ),
      );

    const grantees = rows.map((row) => ({
      grantedTo: row.grantedTo,
      purpose: row.purpose,
      oneTime: row.oneTime,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }));

    return NextResponse.json({ field, count: grantees.length, grantees });
  } catch (error) {
    log.error({ err: String(error), field }, 'Vault grantees error');
    return toVaultErrorResponse(error, 'Failed to list grantees', 500);
  }
}
