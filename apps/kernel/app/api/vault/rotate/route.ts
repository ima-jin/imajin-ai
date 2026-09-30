import { NextRequest, NextResponse } from 'next/server';
import { publish } from '@imajin/bus';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { rotateAndStore, vaultService } from '@/src/lib/vault';
import { ensureVaultHotReloadReactorRegistered } from '@/src/lib/vault/subscribe';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { listOtherActiveGrantees } from '@/src/lib/vault/grantees';

const log = createLogger('kernel');
ensureVaultHotReloadReactorRegistered();

const nodeDid = process.env.NODE_DID ?? 'did:imajin:node';

interface RotateVaultBody {
  field: string;
  value: string;
  /** Required, and must equal `field` exactly, when the field has other active grantees (#2450). */
  confirmField?: string;
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

  const { field, value, confirmField } = body;

  if (typeof field !== 'string' || field.trim().length === 0) {
    return NextResponse.json({ error: 'field is required' }, { status: 400 });
  }
  if (typeof value !== 'string' || value.length === 0) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 });
  }
  const trimmedField = field.trim();

  try {
    const existing = await vaultService.get(trimmedField);
    if (!existing) {
      return NextResponse.json({ error: 'Field not found' }, { status: 404 });
    }

    // #2450 — fail-closed server-side, not just in the dialog: rotating
    // re-seals under a new key and re-grants only the node's own self-grant,
    // so any OTHER active grantee's copy of the wrapped key silently stops
    // decrypting. The review on #2449 found the browser-only check failed
    // open (a raw POST with no confirmation still rotated). Computed with
    // the exact same query the admin panel's warning uses, so the two can't
    // drift.
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

    // rotateAndStore keeps the superseded grant's purpose; internal-secret:*
    // fields also keep their provisions row + external grantees (#2446).
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
      // Surfaces which custody path the rotation actually took (#1546) — a v2
      // field must still read 'delegation-grant' after rotating, not silently
      // downgrade to node-sealed.
      custodyScheme: entry.custodyScheme ?? 'node-sealed',
      status: published ? 'confirmed' : 'pending',
    });
  } catch (error) {
    log.error({ err: String(error), field }, 'Vault rotate error');
    return toVaultErrorResponse(error, 'Failed to rotate secret', 400);
  }
}
