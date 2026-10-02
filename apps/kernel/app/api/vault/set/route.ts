import { NextRequest, NextResponse } from 'next/server';
import { publish } from '@imajin/bus';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { sealAndStore, sealAndStoreV2, vaultService } from '@/src/lib/vault';
import { ensureVaultHotReloadReactorRegistered } from '@/src/lib/vault/subscribe';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { listOtherActiveGrantees } from '@/src/lib/vault/grantees';
import { isInternalSecretField } from '@/src/lib/vault/internal-secret-field';

const log = createLogger('kernel');
ensureVaultHotReloadReactorRegistered();

const nodeDid = process.env.NODE_DID ?? 'did:imajin:node';

interface SetVaultBody {
  field: string;
  value: string;
  custodyScheme?: 'node-sealed' | 'delegation-grant';
  expiresAt?: string; // ISO 8601 — only used when custodyScheme === 'delegation-grant'
  /** Required, and must equal `field` exactly, when set would re-seal an existing field that has other active grantees (#2452). */
  confirmField?: string;
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: SetVaultBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { field, value, custodyScheme, expiresAt, confirmField } = body;

  if (typeof field !== 'string' || field.trim().length === 0) {
    return NextResponse.json({ error: 'field is required' }, { status: 400 });
  }
  if (typeof value !== 'string' || value.length === 0) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 });
  }
  if (custodyScheme !== undefined && custodyScheme !== 'node-sealed' && custodyScheme !== 'delegation-grant') {
    return NextResponse.json({ error: "custodyScheme must be 'node-sealed' or 'delegation-grant'" }, { status: 400 });
  }

  let expiresAtDate: Date | null = null;
  if (expiresAt !== undefined) {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'expiresAt must be a valid ISO 8601 date' }, { status: 400 });
    }
    expiresAtDate = parsed;
  }

  const trimmedField = field.trim();

  // #2452 — fail-closed, server-side (same posture as Rotate/Delete, #2449):
  // internal-secret:* fields are the kernel's own secrets and are never
  // operator-set. Provisioning goes through the internal-secret path and
  // replacement through Rotate.
  if (isInternalSecretField(trimmedField)) {
    return NextResponse.json(
      { error: `'${trimmedField}' is a kernel-internal secret and cannot be set by an operator.` },
      { status: 409 },
    );
  }

  try {
    // #2452 — set on an EXISTING field is a re-seal under a new key, exactly the
    // harm Rotate guards against (#2450): any other active grantee's wrapped key
    // stops decrypting. Same guard query as Rotate, same typed confirmField.
    const existing = await vaultService.get(trimmedField);
    if (existing) {
      const identity = getNodeSigningIdentity();
      const otherGrantees = await listOtherActiveGrantees(trimmedField, identity.senderDid);
      if (otherGrantees.length > 0 && confirmField !== trimmedField) {
        return NextResponse.json(
          {
            error: `'${trimmedField}' already exists and ${otherGrantees.length} active grantee(s) hold a grant on it — use Rotate, or resend with confirmField: "${trimmedField}" to re-seal anyway.`,
            count: otherGrantees.length,
            grantees: otherGrantees,
          },
          { status: 409 },
        );
      }
    }

    if (custodyScheme === 'delegation-grant') {
      return await handleDelegationGrantSet(trimmedField, value, expiresAtDate);
    }

    const entry = await sealAndStore(trimmedField, value);

    let published = true;
    try {
      await publish('vault.secret.updated', {
        issuer: entry.senderDid,
        subject: nodeDid,
        scope: 'vault',
        payload: {
          field: entry.field,
          cid: entry.cid,
          senderDid: entry.senderDid,
          context_id: entry.field,
          context_type: 'vault',
        },
      });
    } catch (err) {
      published = false;
      log.error({ err: String(err) }, 'Bus publish error for vault.secret.updated');
    }

    return NextResponse.json({
      field: entry.field,
      cid: entry.cid,
      timestamp: entry.timestamp,
      senderDid: entry.senderDid,
      status: published ? 'confirmed' : 'pending',
    });
  } catch (error) {
    log.error({ err: String(error), field }, 'Vault set error');
    return toVaultErrorResponse(error, 'Failed to seal and store secret', 400);
  }
}

async function handleDelegationGrantSet(
  field: string,
  value: string,
  expiresAt: Date | null,
): Promise<NextResponse> {
  const { entry, grantId } = await sealAndStoreV2(field, value, { expiresAt });

  let published = true;
  try {
    await publish('vault.secret.updated', {
      issuer: entry.senderDid,
      subject: nodeDid,
      scope: 'vault',
      payload: {
        field: entry.field,
        cid: entry.cid,
        senderDid: entry.senderDid,
        context_id: entry.field,
        context_type: 'vault',
      },
    });
  } catch (err) {
    published = false;
    log.error({ err: String(err) }, 'Bus publish error for vault.secret.updated (v2)');
  }

  return NextResponse.json({
    field: entry.field,
    cid: entry.cid,
    timestamp: entry.timestamp,
    senderDid: entry.senderDid,
    custodyScheme: 'delegation-grant',
    grantId,
    status: published ? 'confirmed' : 'pending',
  });
}
