import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { loadAndUnseal, sealAndStoreV2 } from '@/src/lib/vault';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/**
 * POST /api/vault/upgrade-custody — re-seal a `node-sealed` field as `delegation-grant`.
 *
 * Admin-only. Unseals the existing v1 ciphertext server-side (no value re-entry)
 * and re-seals it as a v2 delegation-grant entry with a self-grant in Tier 0.
 * Idempotent: calling on a field that is already `delegation-grant` replaces the
 * existing grant with a fresh one (sealAndStoreV2 supersedes atomically).
 *
 * No plaintext is logged at any point.
 */
export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { field?: unknown };
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
    const plaintext = await loadAndUnseal(trimmedField);
    if (plaintext === undefined) {
      return NextResponse.json(
        { error: `Field '${trimmedField}' not found` },
        { status: 404 },
      );
    }

    const { entry, grantId } = await sealAndStoreV2(trimmedField, plaintext);
    const identity = getNodeSigningIdentity();

    log.info({ field: trimmedField, grantId }, 'Vault field upgraded to delegation-grant custody');

    return NextResponse.json({
      field: entry.field,
      cid: entry.cid,
      timestamp: entry.timestamp,
      senderDid: entry.senderDid,
      custodyScheme: 'delegation-grant',
      grantId,
      grantedTo: identity.senderDid,
    });
  } catch (error) {
    log.error({ err: String(error), field: trimmedField }, 'Vault upgrade-custody error');
    return toVaultErrorResponse(error, 'Failed to upgrade vault field custody', 500);
  }
}
