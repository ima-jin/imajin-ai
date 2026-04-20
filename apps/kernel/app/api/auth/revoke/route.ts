/**
 * POST /api/auth/revoke
 *
 * Revokes a previously granted app authorization.
 * Creates an app.revoked attestation and marks the original as revoked.
 *
 * Body: { attestationId }
 * Returns: { ok: true }
 */

import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, attestations } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth, canonicalize, crypto as authCrypto } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

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

  const issuedAtMs = Date.now();
  const payload = { revokedAttestationId: attestationId, appDid: original.subjectDid };

  const canonicalPayload = canonicalize({
    subject_did: original.subjectDid,
    type: 'app.revoked',
    context_id: attestationId,
    context_type: 'attestation',
    payload,
    issued_at: issuedAtMs,
  });

  const signature = authCrypto.signSync(canonicalPayload, privateKey);

  await db.insert(attestations).values({
    id: `att_${nanoid(16)}`,
    issuerDid: identity.id,
    subjectDid: original.subjectDid,
    type: 'app.revoked',
    contextId: attestationId,
    contextType: 'attestation',
    payload,
    signature,
    issuedAt: new Date(issuedAtMs),
  });

  // Mark original as revoked
  await db
    .update(attestations)
    .set({ revokedAt: new Date(issuedAtMs) })
    .where(eq(attestations.id, attestationId));

  return NextResponse.json({ ok: true });
});
