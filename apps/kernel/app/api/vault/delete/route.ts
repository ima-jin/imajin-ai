import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { publish } from '@imajin/bus';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { deleteFromVault, eraseInactiveGrantKeyMaterial, vaultService } from '@/src/lib/vault';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { listOtherActiveGrantees } from '@/src/lib/vault/grantees';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';
import { isInternalSecretField } from '@/src/lib/vault/field-grammar';
import { db, vaultDelegationGrants } from '@/src/db';

const log = createLogger('kernel');

const nodeDid = process.env.NODE_DID ?? 'did:imajin:node';

interface DeleteVaultBody {
  field: string;
  /** Required, and must equal `field` exactly, when the field has other active grantees (#2450). */
  confirmField?: string;
}

/**
 * POST /api/vault/delete (#2445 defect 5, #2450) — retire a mis-named or
 * dead row from the admin panel.
 *
 * Three guards, all enforced HERE — not just in the dialog, after the
 * review on #2449 found a raw POST with no confirmation still succeeded
 * against a field with an active external grantee:
 *
 *   1. `internal-secret:*` is refused outright (#2450 DECISION a, #2245
 *      ruling): these are kernel self-provisioned; a human replaces or
 *      destroys them only through Rotate's countersigned path.
 *   2. Already-tombstoned or never-existed -> 404 (idempotent delete-of-
 *      already-deleted used to write a second tombstone and a second
 *      event; `vaultService.peek` — which does NOT hide tombstones, unlike
 *      `.get` — is used here specifically to catch that).
 *   3. Any OTHER active grantee on the field (computed server-side via the
 *      same `listOtherActiveGrantees` the warning UI calls) requires the
 *      request body to name the field exactly as `confirmField` — a
 *      mismatch or omission is a 409, not a silent 200.
 *
 * On success, every active grant on the field (the node's own self-grant
 * included — there is nothing left for it to cover) is revoked and its key
 * material erased, so nothing is left "active" and pointing at a tombstone.
 */
export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: DeleteVaultBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { field, confirmField } = body;
  if (typeof field !== 'string' || field.trim().length === 0) {
    return NextResponse.json({ error: 'field is required' }, { status: 400 });
  }
  const trimmedField = field.trim();

  if (isInternalSecretField(trimmedField)) {
    return NextResponse.json(
      {
        error: `${trimmedField} is kernel self-provisioned (#2245) — replace it via Rotate, not Delete.`,
        code: 'INTERNAL_SECRET_DELETE_REFUSED',
      },
      { status: 409 },
    );
  }

  try {
    const existing = await vaultService.peek(trimmedField);
    if (!existing || existing.deleted === true) {
      return NextResponse.json({ error: `No vault entry found for field '${trimmedField}'` }, { status: 404 });
    }

    const identity = getNodeSigningIdentity();
    const otherGrantees = await listOtherActiveGrantees(trimmedField, identity.senderDid);
    if (otherGrantees.length > 0 && confirmField !== trimmedField) {
      return NextResponse.json(
        {
          error: `${otherGrantees.length} active grantee(s) hold a grant on '${trimmedField}' — resend with confirmField: "${trimmedField}" to proceed.`,
          count: otherGrantees.length,
          grantees: otherGrantees,
        },
        { status: 409 },
      );
    }

    const tombstone = await deleteFromVault(trimmedField);
    if (!tombstone) {
      return NextResponse.json({ error: `No vault entry found for field '${trimmedField}'` }, { status: 404 });
    }

    const revoked = await db
      .update(vaultDelegationGrants)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(vaultDelegationGrants.field, trimmedField), eq(vaultDelegationGrants.status, 'active')))
      .returning({
        id: vaultDelegationGrants.id,
        field: vaultDelegationGrants.field,
        keyId: vaultDelegationGrants.keyId,
        grantedTo: vaultDelegationGrants.grantedTo,
      });
    await eraseInactiveGrantKeyMaterial(revoked);

    publish('vault.secret.deleted', {
      issuer: identity.senderDid,
      subject: nodeDid,
      scope: 'vault',
      payload: {
        field: trimmedField,
        cid: tombstone.cid,
        senderDid: tombstone.senderDid,
        revokedGrants: revoked.map((g) => g.grantedTo),
        context_id: trimmedField,
        context_type: 'vault',
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Bus publish error for vault.secret.deleted');
    });

    return NextResponse.json({
      ok: true,
      field: trimmedField,
      cid: tombstone.cid,
      timestamp: tombstone.timestamp,
      revokedGrantCount: revoked.length,
    });
  } catch (error) {
    log.error({ err: String(error), field: trimmedField }, 'Vault delete error');
    return toVaultErrorResponse(error, 'Failed to delete vault entry', 400);
  }
}
