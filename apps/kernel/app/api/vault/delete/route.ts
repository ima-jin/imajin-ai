import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { vaultService } from '@/src/lib/vault';
import { deleteSecretAndRevokeGrants } from '@/src/lib/vault/delete-secret';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';
import { listOtherActiveGrantees } from '@/src/lib/vault/grantees';
import { isInternalSecretField, parseVaultFieldName } from '@/src/lib/vault/field-grammar';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';

const log = createLogger('kernel');

interface DeleteVaultBody {
  field?: unknown;
  /** Must equal `field` exactly when the field has other active grantees. */
  confirmField?: unknown;
}

function notFound(field: string): NextResponse {
  return NextResponse.json({ error: `No vault entry found for field '${field}'` }, { status: 404 });
}

/**
 * DELETE /api/vault/delete (#2698, #2701) — retire a sealed vault field.
 *
 * Operator-only (`requireAdmin`, like every other operator vault route).
 * Enforced HERE, not just in the dialog:
 *
 *   1. `internal-secret:*` is refused with a 400 — those are kernel
 *      self-provisioned; replacement is Rotate (#2245, #2450).
 *   2. A missing or already-tombstoned field is a 404. `vaultService.peek`
 *      is used (not `.get`, which hides tombstones) so a tombstone is never
 *      re-tombstoned.
 *   3. When other grantees hold an active grant, the body must repeat the
 *      field name as `confirmField`; otherwise a 409 carries the grantee
 *      COUNT (never any secret value) so the caller can warn and retry.
 *
 * On success every active grant on the field is revoked and its key material
 * erased in the SAME transaction as the tombstone (`deleteSecretAndRevokeGrants`),
 * so no grant is left active and pointing at a tombstone.
 */
export async function DELETE(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: DeleteVaultBody | null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { field, confirmField } = body ?? {};
  const parsedField = parseVaultFieldName(field);
  if (!parsedField.ok) {
    return NextResponse.json({ error: parsedField.message }, { status: 400 });
  }
  const trimmedField = parsedField.value.field;

  if (isInternalSecretField(trimmedField)) {
    return NextResponse.json(
      {
        error: `'${trimmedField}' is a kernel-internal secret and cannot be deleted by an operator — replace it via Rotate.`,
        code: 'INTERNAL_SECRET_DELETE_REFUSED',
      },
      { status: 400 },
    );
  }

  try {
    const existing = await vaultService.peek(trimmedField);
    if (!existing || existing.deleted === true) {
      return notFound(trimmedField);
    }

    const identity = getNodeSigningIdentity();
    const otherGrantees = await listOtherActiveGrantees(trimmedField, identity.senderDid);
    if (otherGrantees.length > 0 && confirmField !== trimmedField) {
      return NextResponse.json(
        {
          error: `${otherGrantees.length} active grantee(s) hold a grant on '${trimmedField}' — resend with confirmField: "${trimmedField}" to delete and revoke them.`,
          code: 'GRANTEE_CONFIRMATION_REQUIRED',
          count: otherGrantees.length,
        },
        { status: 409 },
      );
    }

    const result = await deleteSecretAndRevokeGrants(trimmedField);
    if (!result) {
      return notFound(trimmedField);
    }

    log.info(
      { field: trimmedField, cid: result.tombstone.cid, revokedGrantCount: result.revokedGrantees.length },
      'Vault: field deleted — tombstoned and active grants revoked in one transaction',
    );

    return NextResponse.json({
      ok: true,
      field: trimmedField,
      cid: result.tombstone.cid,
      timestamp: result.tombstone.timestamp,
      revokedGrantCount: result.revokedGrantees.length,
    });
  } catch (error) {
    log.error({ err: String(error), field: trimmedField }, 'Vault delete error');
    return toVaultErrorResponse(error, 'Failed to delete vault entry', 400);
  }
}
