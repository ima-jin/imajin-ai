import { NextRequest, NextResponse } from 'next/server';
import { publish } from '@imajin/bus';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { deleteFromVault } from '@/src/lib/vault';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

const nodeDid = process.env.NODE_DID ?? 'did:imajin:node';

interface DeleteVaultBody {
  field: string;
}

/**
 * POST /api/vault/delete (#2445 defect 5) — retire a mis-named or dead row
 * from the admin panel. Writes a signed tombstone via `deleteFromVault`
 * (existing deleted-flag semantics; `vaultService.list()` already excludes
 * tombstoned entries) rather than removing history, so the audit chain
 * stays intact. Emits `vault.secret.deleted` best-effort, matching the
 * set/rotate routes' publish-and-log-on-failure pattern.
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

  const { field } = body;
  if (typeof field !== 'string' || field.trim().length === 0) {
    return NextResponse.json({ error: 'field is required' }, { status: 400 });
  }
  const trimmedField = field.trim();

  try {
    const tombstone = await deleteFromVault(trimmedField);
    if (!tombstone) {
      return NextResponse.json(
        { error: `No vault entry found for field '${trimmedField}'` },
        { status: 404 },
      );
    }

    const identity = getNodeSigningIdentity();
    publish('vault.secret.deleted', {
      issuer: identity.senderDid,
      subject: nodeDid,
      scope: 'vault',
      payload: {
        field: trimmedField,
        cid: tombstone.cid,
        senderDid: tombstone.senderDid,
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
    });
  } catch (error) {
    log.error({ err: String(error), field: trimmedField }, 'Vault delete error');
    return toVaultErrorResponse(error, 'Failed to delete vault entry', 400);
  }
}
