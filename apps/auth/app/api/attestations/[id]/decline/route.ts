import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/middleware';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/attestations/:id/decline
 *
 * Witness explicitly declines an attestation.
 * Only the attestation subject can decline.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  const session = await requireAuth(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const { id } = await params;

  const [att] = await db.select().from(attestations).where(eq(attestations.id, id)).limit(1);
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
    .where(eq(attestations.id, id));

  return NextResponse.json({
    id,
    status: 'declined',
  }, { headers: cors });
}
