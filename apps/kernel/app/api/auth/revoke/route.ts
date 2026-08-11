/**
 * POST /api/auth/revoke
 *
 * Revokes a previously granted app authorization.
 * Creates an app.revoked attestation and marks the original as revoked.
 *
 * Body: { attestationId }
 * Returns: { ok: true }
 *
 * Revocation itself is delegated to revokeAttestationOnce() (#1795), which
 * atomically claims the attestation (compare-and-swap on revokedAt) before
 * writing anything — so a retry storm or concurrent revoke calls against the
 * same attestation can never produce more than one `app.revoked` record.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, attestations } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { withLogger } from '@imajin/logger';
import { revokeAttestationOnce } from '@/src/lib/auth/revoke-attestation';

export const POST = withLogger('kernel', async (request: NextRequest) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { attestationId } = body as { attestationId?: string };
  if (!attestationId || typeof attestationId !== 'string') {
    return NextResponse.json({ error: 'attestationId is required' }, { status: 400 });
  }

  // Load original authorization — must belong to this user
  const [original] = await db
    .select()
    .from(attestations)
    .where(
      and(
        eq(attestations.id, attestationId),
        eq(attestations.issuerDid, identity.id),
        eq(attestations.type, 'app.authorized'),
      )
    );

  if (!original) {
    return NextResponse.json({ error: 'Authorization not found' }, { status: 404 });
  }
  if (original.revokedAt) {
    return NextResponse.json({ error: 'Already revoked' }, { status: 409 });
  }

  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const { revoked } = await revokeAttestationOnce({
    attestationId,
    revokedByDid: identity.id,
    privateKey,
  });

  if (!revoked) {
    // Lost the compare-and-swap to a concurrent revoke call against the same
    // attestation — idempotent no-op rather than a duplicate `app.revoked`
    // record (#1795).
    return NextResponse.json({ error: 'Already revoked' }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
});
