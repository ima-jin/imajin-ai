import { NextRequest, NextResponse } from 'next/server';
import { publish } from '@imajin/bus';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { rotateAndStore, vaultService } from '@/src/lib/vault';
import { ensureVaultHotReloadReactorRegistered } from '@/src/lib/vault/subscribe';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');
ensureVaultHotReloadReactorRegistered();

const nodeDid = process.env.NODE_DID ?? 'did:imajin:node';

interface RotateVaultBody {
  field: string;
  value: string;
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

  const { field, value } = body;

  if (typeof field !== 'string' || field.trim().length === 0) {
    return NextResponse.json({ error: 'field is required' }, { status: 400 });
  }
  if (typeof value !== 'string' || value.length === 0) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 });
  }

  try {
    const existing = await vaultService.get(field.trim());
    if (!existing) {
      return NextResponse.json({ error: 'Field not found' }, { status: 404 });
    }

    const entry = await rotateAndStore(field.trim(), value);

    let published = true;
    try {
      await publish('vault.secret.rotated', {
        issuer: entry.senderDid,
        subject: nodeDid,
        scope: 'vault',
        payload: {
          field: entry.field,
          cid: entry.cid,
          previousCid: existing.cid,
          senderDid: entry.senderDid,
          context_id: entry.field,
          context_type: 'vault',
        },
      });
    } catch (err) {
      published = false;
      log.error({ err: String(err) }, 'Bus publish error for vault.secret.rotated');
    }

    return NextResponse.json({
      field: entry.field,
      cid: entry.cid,
      previousCid: existing.cid,
      timestamp: entry.timestamp,
      senderDid: entry.senderDid,
      status: published ? 'confirmed' : 'pending',
    });
  } catch (error) {
    log.error({ err: String(error), field }, 'Vault rotate error');
    return toVaultErrorResponse(error, 'Failed to rotate secret', 400);
  }
}
