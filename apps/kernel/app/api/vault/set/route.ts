import { NextRequest, NextResponse } from 'next/server';
import {
  computeVaultCid,
  deriveKeyId,
  assertEntryIntegrity,
  createDefaultAdapters,
  VAULT_ENTRY_VERSION_V1,
  type VaultEntry,
} from '@imajin/vault-core';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { vaultService } from '@/src/lib/vault';
import { notifySubscribers } from '@/src/lib/vault/subscribe';

const log = createLogger('kernel');

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

    const adapters = createDefaultAdapters();
    await assertEntryIntegrity(entry, adapters);

    const persisted = await vaultService.set(entry);

    publish('vault.secret.updated', {
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
    }).catch((err) => {
      log.error({ err: String(err) }, 'Bus publish error for vault.secret.updated');
    });

    await notifySubscribers(field, persisted);

    return NextResponse.json({
      field,
      cid,
      timestamp,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('signature')) {
      return NextResponse.json({ error: 'Unauthorized: signature verification failed' }, { status: 401 });
    }
    if (error instanceof Error && error.message.includes('DID')) {
      return NextResponse.json({ error: 'Forbidden: DID binding failed' }, { status: 403 });
    }
    log.error({ err: String(error), field }, 'Vault set error');
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
}
