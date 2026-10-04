import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { getRotateGranteeGuard } from '@/src/lib/vault/grantees';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/**
 * GET /api/vault/grantees/[field] (#2450 step 1) — every currently-usable
 * delegation grant on `field` OTHER than the node's own self-grant, so the
 * admin panel's Rotate dialog can warn an operator BEFORE they act: rotating
 * a field re-seals it under a new key, so every other DID's existing grant
 * would point at the OLD sealed material and silently fail to decrypt
 * (#2446/#2448/#2450) unless rotate re-issues it — which it does.
 *
 * Read-only and purely informational for the UI: the count and shape here
 * are shared (via `getRotateGranteeGuard`) with the SERVER-SIDE guard on
 * `POST /api/vault/rotate`, which enforces the same decision itself rather
 * than trusting whatever the browser saw. `reissuedOnRotate` is true when
 * rotating re-issues those grantees (Tier 0); false means rotate refuses
 * while they exist (Tier 1 custody cannot sign replacement grants).
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ field: string }> }) {
  const params = await props.params;
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { field } = params;

  try {
    const identity = getNodeSigningIdentity();
    const { grantees, reissuedOnRotate } = await getRotateGranteeGuard(field, identity.senderDid);
    return NextResponse.json({ field, count: grantees.length, grantees, reissuedOnRotate });
  } catch (error) {
    log.error({ err: String(error), field }, 'Vault grantees error');
    return toVaultErrorResponse(error, 'Failed to list grantees', 500);
  }
}
