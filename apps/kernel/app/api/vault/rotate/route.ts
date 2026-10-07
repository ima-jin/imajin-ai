import { NextRequest, NextResponse } from 'next/server';
import { publish } from '@imajin/bus';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { rotateAndStore, vaultService } from '@/src/lib/vault';
import { ensureVaultHotReloadReactorRegistered } from '@/src/lib/vault/subscribe';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { getRotateGranteeGuard } from '@/src/lib/vault/grantees';
import { parseVaultFieldName } from '@/src/lib/vault/field-grammar';

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

  const parsedField = parseVaultFieldName(field);
  if (!parsedField.ok) {
    return NextResponse.json({ error: parsedField.message }, { status: 400 });
  }
  if (typeof value !== 'string' || value.length === 0) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 });
  }

  const trimmedField = parsedField.value.field;

  try {
    const existing = await vaultService.get(trimmedField);
    if (!existing) {
      return NextResponse.json({ error: 'Field not found' }, { status: 404 });
    }

    // #2450 — rotating re-seals under a new key, so every OTHER active
    // grantee's copy of the wrapped key would stop decrypting. rotateAndStore
    // re-issues them (same grantee set, expiry / one-time / purpose carried
    // forward), so this only blocks when it cannot: Tier 1 vault custody,
    // where the node has no owner key to sign replacement grants. Computed
    // with the exact same query the admin panel's list uses, so the two
    // can't drift; there is deliberately no confirm-and-strand override.
    const identity = getNodeSigningIdentity();
    const { grantees: otherGrantees, reissuedOnRotate } = await getRotateGranteeGuard(trimmedField, identity.senderDid);
    if (otherGrantees.length > 0 && !reissuedOnRotate) {
      return NextResponse.json(
        {
          error: `${otherGrantees.length} active grantee(s) hold a grant on '${trimmedField}' and this node cannot re-issue them (Tier 1 vault custody) — revoke them first; nothing was changed.`,
          count: otherGrantees.length,
          grantees: otherGrantees,
        },
        { status: 409 },
      );
    }

    // rotateAndStore keeps the superseded grant's purpose and re-issues every
    // external grantee on the new key (#2446 internal-secret:*, #2450 all).
    const entry = await rotateAndStore(trimmedField, value);

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
