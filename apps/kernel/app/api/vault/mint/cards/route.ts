import { NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { listVaultKeyCards, listHandProvisionedFields } from '@/src/lib/vault';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/**
 * GET /api/vault/mint/cards — the /jin "Vault" section's read model (#2247):
 * one timeline card per minted key, plus the "hand-provisioned" filter list
 * (rotation-sweep candidates). Never returns key material of any kind —
 * every field here is bookkeeping (who/when/purpose), never the private
 * key or the sealed ciphertext.
 *
 * Auth: `requireAdmin`, matching every other `/api/vault/**` admin route
 * (`list`, `set`, `rotate`, `delegation/grant`, ...).
 */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [keys, handProvisioned] = await Promise.all([
      listVaultKeyCards(),
      listHandProvisionedFields(),
    ]);
    return NextResponse.json({ keys, handProvisioned });
  } catch (error) {
    log.error({ err: String(error) }, 'Vault key cards listing error');
    return toVaultErrorResponse(error, 'Failed to list vault key cards', 500);
  }
}
