import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants } from '@/src/db';
import { eraseInactiveGrantKeyMaterial } from '@/src/lib/vault';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';

const log = createLogger('kernel');

/**
 * POST /api/vault/delegation/revoke — revoke the active delegation grant for a field.
 *
 * Marks the active vault_delegation_grants row for (field, nodeDid) as 'revoked'
 * and erases its wrapped key material.
 *
 * The erase is the part that makes revocation real. A status change alone only
 * stops `fetchActiveGrant` from returning the row — the wrapped key stayed in the
 * table, so anyone holding `nodeXPriv` and database access could still recover the
 * field key from a revoked grant. Revocation constrained the code path, not an
 * attacker.
 *
 * Erasing is safe because the owner keeps a separate copy in
 * `vault_owner_envelopes`, which is what a later re-grant is issued from. Grants
 * predating that table are left intact and logged rather than erased, since for
 * them the wrapped key is still the only copy.
 *
 * IMPORTANT: revocation does NOT re-encrypt the ciphertext. Any in-process
 * loadAndUnseal that ran before revocation and holds the decrypted value in
 * memory is unaffected. To eliminate the old field key entirely, follow
 * revocation with a POST /api/vault/set to re-seal with a new random key.
 */
export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { field?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { field } = body;
  if (typeof field !== 'string' || field.trim().length === 0) {
    return NextResponse.json({ error: 'field is required' }, { status: 400 });
  }

  const identity = getNodeSigningIdentity();
  const trimmedField = field.trim();

  const revoked = await db
    .update(vaultDelegationGrants)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(vaultDelegationGrants.subject, identity.senderDid),
        eq(vaultDelegationGrants.field, trimmedField),
        eq(vaultDelegationGrants.status, 'active'),
      ),
    )
    .returning();

  if (revoked.length === 0) {
    return NextResponse.json(
      { error: `No active delegation grant found for field '${trimmedField}'` },
      { status: 404 },
    );
  }

  const erasedGrantIds = await eraseInactiveGrantKeyMaterial(revoked);

  for (const grant of revoked) {
    publish('vault.delegation.revoked', {
      issuer: identity.senderDid,
      subject: grant.subject,
      scope: 'vault',
      payload: {
        grantId: grant.id,
        field: grant.field,
        subject: grant.subject,
        grantedTo: grant.grantedTo,
        context_id: grant.id,
        context_type: 'vault.delegation',
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Bus publish error for vault.delegation.revoked');
    });
  }

  return NextResponse.json({
    ok: true,
    revokedCount: revoked.length,
    // Surfaced so an operator can tell a real withdrawal from a status-only one.
    // A shortfall here means those grants had no owner envelope and their wrapped
    // key was left in place deliberately.
    keyMaterialErasedCount: erasedGrantIds.length,
    field: trimmedField,
    grants: revoked.map((g) => ({
      id: g.id,
      grantedTo: g.grantedTo,
      revokedAt: g.revokedAt,
      keyMaterialErased: erasedGrantIds.includes(g.id),
    })),
  });
}
