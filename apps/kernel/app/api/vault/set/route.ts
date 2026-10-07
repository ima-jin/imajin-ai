import { NextRequest, NextResponse } from 'next/server';
import { publish } from '@imajin/bus';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { sealAndStore, sealAndStoreV2, vaultService } from '@/src/lib/vault';
import { ensureVaultHotReloadReactorRegistered } from '@/src/lib/vault/subscribe';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { listOtherActiveGrantees } from '@/src/lib/vault/grantees';
import { isInternalSecretField, parseVaultFieldName } from '@/src/lib/vault/field-grammar';

const log = createLogger('kernel');
ensureVaultHotReloadReactorRegistered();

const nodeDid = process.env.NODE_DID ?? 'did:imajin:node';

interface SetVaultBody {
  field: string;
  value: string;
  custodyScheme?: 'node-sealed' | 'delegation-grant';
  expiresAt?: string; // ISO 8601 — only used when custodyScheme === 'delegation-grant'
}

/**
 * #2452 — the #2449 guards Rotate/Delete have, fail-closed and server-side.
 * Returns a 409 response when the set must be refused, or null to proceed.
 *
 *  - internal-secret:* is the kernel's own secret: never operator-set
 *    (provisioning is the internal-secret path, replacement is Rotate).
 *  - set on an EXISTING field re-seals it under a new key — exactly the harm
 *    Rotate guards against (#2450): any other active grantee's wrapped key
 *    stops decrypting. Same guard query as Rotate, and like Rotate no
 *    override: a set that would strand grantees is refused unconditionally
 *    (#2450 / #2495: guard first, never strand). Rotate re-issues grantees.
 */
async function checkSetGuards(field: string): Promise<NextResponse | null> {
  if (isInternalSecretField(field)) {
    return NextResponse.json(
      { error: `'${field}' is a kernel-internal secret and cannot be set by an operator.` },
      { status: 409 },
    );
  }

  if (!(await vaultService.get(field))) return null;

  const identity = getNodeSigningIdentity();
  const otherGrantees = await listOtherActiveGrantees(field, identity.senderDid);
  if (otherGrantees.length === 0) return null;

  return NextResponse.json(
    {
      error: `'${field}' already exists and ${otherGrantees.length} active grantee(s) hold a grant on it — use Rotate instead of Set.`,
      count: otherGrantees.length,
      grantees: otherGrantees,
    },
    { status: 409 },
  );
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

  const { field, value, custodyScheme, expiresAt } = body;

  const parsedField = parseVaultFieldName(field);
  if (!parsedField.ok) {
    return NextResponse.json({ error: parsedField.message }, { status: 400 });
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

  const trimmedField = parsedField.value.field;

  try {
    const refusal = await checkSetGuards(trimmedField);
    if (refusal) return refusal;

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
