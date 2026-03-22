import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/middleware';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/attestations/:id/countersign
 *
 * Witness countersigns an attestation, making it bilateral.
 * Only the attestation subject can countersign.
 *
 * Body: { witnessJws: string }
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
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { witnessJws } = body;
  if (!witnessJws || typeof witnessJws !== 'string') {
    return NextResponse.json({ error: 'witnessJws required' }, { status: 400, headers: cors });
  }

  // Load attestation
  const [att] = await db.select().from(attestations).where(eq(attestations.id, id)).limit(1);
  if (!att) {
    return NextResponse.json({ error: 'Attestation not found' }, { status: 404, headers: cors });
  }

  if (att.attestationStatus !== 'pending') {
    return NextResponse.json(
      { error: `Cannot countersign — attestation is ${att.attestationStatus ?? 'legacy (no status)'}` },
      { status: 409, headers: cors }
    );
  }

  // Only the subject can countersign
  if (session.sub !== att.subjectDid) {
    return NextResponse.json(
      { error: 'Only the attestation subject can countersign' },
      { status: 403, headers: cors }
    );
  }

  // TODO: Verify witnessJws signature matches subject's chain key
  // TODO: Verify witnessJws CID matches attestation CID
  // For now, store the JWS — crypto verification is a fast follow

  await db.update(attestations)
    .set({
      witnessJws: witnessJws as string,
      attestationStatus: 'bilateral',
    })
    .where(eq(attestations.id, id));

  return NextResponse.json({
    id,
    cid: att.cid,
    status: 'bilateral',
  }, { headers: cors });
}
