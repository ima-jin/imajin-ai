import { NextRequest, NextResponse } from 'next/server';
import {
  computeVaultCid,
  deriveKeyId,
  assertEntryIntegrity,
  VAULT_ENTRY_VERSION_V1,
  type VaultEntry,
} from '@imajin/vault-core';
import { publish } from '@imajin/bus';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { vaultAdapters, vaultService } from '@/src/lib/vault';
import { ensureVaultHotReloadReactorRegistered } from '@/src/lib/vault/subscribe';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');
ensureVaultHotReloadReactorRegistered();

const nodeDid = process.env.NODE_DID ?? 'did:imajin:node';

interface SetVaultBody {
  field: string;
  encrypted: string;
  nonce: string;
  senderDid: string;
  senderPubkey: string;
  signature: string;
  timestamp: string;
  previousCid?: string;
  deleted?: boolean;
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

  const {
    field,
    encrypted,
    nonce,
    senderDid,
    senderPubkey,
    signature,
    timestamp,
    previousCid,
    deleted,
  } = body;

  if (
    typeof field !== 'string' ||
    typeof encrypted !== 'string' ||
    typeof nonce !== 'string' ||
    typeof senderDid !== 'string' ||
    typeof senderPubkey !== 'string' ||
    typeof signature !== 'string' ||
    typeof timestamp !== 'string'
  ) {
    return NextResponse.json({ error: 'Missing or invalid required fields' }, { status: 400 });
  }

  try {
    const cid = await computeVaultCid({ encrypted, nonce });
    const keyId = deriveKeyId(senderPubkey);

    const entry: VaultEntry = {
      version: VAULT_ENTRY_VERSION_V1,
      field,
      cid,
      encrypted,
      nonce,
      senderDid,
      senderPubkey,
      keyId,
      signature,
      timestamp,
      ...(previousCid !== undefined ? { previousCid } : {}),
      ...(deleted !== undefined ? { deleted } : {}),
    };

    await assertEntryIntegrity(entry, vaultAdapters);

    await vaultService.set(entry);

    let published = true;
    try {
      await publish('vault.secret.updated', {
        issuer: entry.senderDid,
        subject: nodeDid,
        scope: 'vault',
        payload: {
          field,
          cid,
          senderDid,
          context_id: field,
          context_type: 'vault',
        },
      });
    } catch (err) {
      published = false;
      log.error({ err: String(err) }, 'Bus publish error for vault.secret.updated');
    }

    return NextResponse.json({
      field,
      cid,
      timestamp,
      senderDid,
      status: published ? 'confirmed' : 'pending',
    });
  } catch (error) {
    log.error({ err: String(error), field }, 'Vault set error');
    return toVaultErrorResponse(error, 'Validation failed', 400);
  }
}
