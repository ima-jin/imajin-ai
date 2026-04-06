import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/src/lib/auth/middleware';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/attestations/decline
 *
 * Witness explicitly declines an attestation.
 * Only the attestation subject can decline.
 *
 * Body: { attestationId: string }
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const session = await requireAuth(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { attestationId } = body;
  if (!attestationId || typeof attestationId !== 'string') {
    return NextResponse.json({ error: 'attestationId required' }, { status: 400, headers: cors });
  }

  const [att] = await db.select().from(attestations).where(eq(attestations.id, attestationId)).limit(1);
  if (!att) {
    return NextResponse.json({ error: 'Attestation not found' }, { status: 404, headers: cors });
  }

  if (att.attestationStatus !== 'pending') {
    return NextResponse.json(
      { error: `Cannot decline — attestation is ${att.attestationStatus ?? 'legacy (no status)'}` },
      { status: 409, headers: cors }
    );
  }

  if (session.sub !== att.subjectDid) {
    return NextResponse.json(
      { error: 'Only the attestation subject can decline' },
      { status: 403, headers: cors }
    );
  }

  await db.update(attestations)
    .set({ attestationStatus: 'declined' })
    .where(eq(attestations.id, attestationId));

  return NextResponse.json({
    id: attestationId,
    status: 'declined',
  }, { headers: cors });
}
