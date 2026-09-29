import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { listOtherActiveGrantees } from '@/src/lib/vault/grantees';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/**
 * GET /api/vault/grantees/[field] (#2450 step 1) — every currently-usable
 * delegation grant on `field` OTHER than the node's own self-grant, so the
 * admin panel's Rotate and Delete dialogs can warn an operator BEFORE they
 * act: rotating or deleting a field re-seals or tombstones it under the
 * node's own custody, but does nothing to any other DID's existing grant —
 * that grantee's copy of the wrapped key still points at the OLD sealed
 * material, so its next fetch silently fails to decrypt (#2446/#2448/#2450).
 *
 * Read-only. The count and shape returned here are shared (via
 * `listOtherActiveGrantees`) with the SERVER-SIDE guard on
 * `POST /api/vault/rotate` and `POST /api/vault/delete` — the review on
 * #2449 found the client-only version of this check failed open (a raw
 * POST with no confirmation still succeeded), so this endpoint is now
 * purely informational for the UI; the routes enforce the same query
 * themselves rather than trusting whatever the browser saw.
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ field: string }> }) {
  const params = await props.params;
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { field } = params;

  try {
    const identity = getNodeSigningIdentity();
    const grantees = await listOtherActiveGrantees(field, identity.senderDid);
    return NextResponse.json({ field, count: grantees.length, grantees });
  } catch (error) {
    log.error({ err: String(error), field }, 'Vault grantees error');
    return toVaultErrorResponse(error, 'Failed to list grantees', 500);
  }
}
