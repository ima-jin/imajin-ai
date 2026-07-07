import { NextRequest, NextResponse } from 'next/server';
import { publish } from '@imajin/bus';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { sealAndStore, sealAndStoreV2 } from '@/src/lib/vault';
import { ensureVaultHotReloadReactorRegistered } from '@/src/lib/vault/subscribe';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');
ensureVaultHotReloadReactorRegistered();

const nodeDid = process.env.NODE_DID ?? 'did:imajin:node';

interface SetVaultBody {
  field: string;
  value: string;
  custodyScheme?: 'node-sealed' | 'delegation-grant';
  expiresAt?: string; // ISO 8601 — only used when custodyScheme === 'delegation-grant'
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

  try {
    if (custodyScheme === 'delegation-grant') {
      const { entry, grantId } = await sealAndStoreV2(field.trim(), value, { expiresAt: expiresAtDate });

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

    const entry = await sealAndStore(field.trim(), value);

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
