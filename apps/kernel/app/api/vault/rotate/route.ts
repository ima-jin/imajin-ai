import { NextRequest, NextResponse } from 'next/server';
import {
  assertEntryIntegrity,
  prepareRotationEntryFromSignedInput,
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

interface RotateVaultBody {
  field: string;
  encrypted: string;
  nonce: string;
  senderDid: string;
  senderPubkey: string;
  signature: string;
  timestamp: string;
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: RotateVaultBody;
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
    const existing = await vaultService.get(field);
    if (!existing) {
      return NextResponse.json({ error: 'Field not found' }, { status: 404 });
    }

    const entry = await prepareRotationEntryFromSignedInput(
      existing,
      { encrypted, nonce },
      { senderDid, senderPubkey, signature, timestamp }
    );

    await assertEntryIntegrity(entry, vaultAdapters);

    const persisted = await vaultService.set(entry);
    let published = true;
    try {
      await publish('vault.secret.rotated', {
        issuer: entry.senderDid,
        subject: nodeDid,
        scope: 'vault',
        payload: {
          field,
          cid: entry.cid,
          previousCid: existing.cid,
          senderDid,
          context_id: field,
          context_type: 'vault',
        },
      });
    } catch (err) {
      published = false;
      log.error({ err: String(err) }, 'Bus publish error for vault.secret.rotated');
    }

    return NextResponse.json({
      field,
      cid: entry.cid,
      previousCid: existing.cid,
      timestamp: persisted.timestamp,
      senderDid,
      status: published ? 'confirmed' : 'pending',
    });
  } catch (error) {
    log.error({ err: String(error), field }, 'Vault rotate error');
    return toVaultErrorResponse(error, 'Validation failed', 400);
  }
}
