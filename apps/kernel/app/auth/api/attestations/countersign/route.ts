import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/src/lib/auth/middleware';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/attestations/countersign
 *
 * Witness countersigns an attestation, making it bilateral.
 * Only the attestation subject can countersign.
 *
 * Body: { attestationId: string, witnessJws: string }
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

  const { attestationId, witnessJws } = body;
  if (!attestationId || typeof attestationId !== 'string') {
    return NextResponse.json({ error: 'attestationId required' }, { status: 400, headers: cors });
  }
  if (!witnessJws || typeof witnessJws !== 'string') {
    return NextResponse.json({ error: 'witnessJws required' }, { status: 400, headers: cors });
  }

  // Load attestation
  const [att] = await db.select().from(attestations).where(eq(attestations.id, attestationId)).limit(1);
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
    .where(eq(attestations.id, attestationId));

  return NextResponse.json({
    id: attestationId,
    cid: att.cid,
    status: 'bilateral',
  }, { headers: cors });
}
