import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { eq } from 'drizzle-orm';
import { resolveEffectiveDid } from '@imajin/auth';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/attestations/countersign
 *
 * Witness countersigns an attestation, making it bilateral.
 * Only the attestation subject can countersign.
 *
 * #1824: this used to gate on the kernel-local, cookie-only `requireAuth`
 * (`@/src/lib/auth/middleware`), which never even looked at an
 * `Authorization: Bearer` header — so ANY app-delegated call (e.g.
 * AgriFortress countersigning on behalf of its delegating user) 401'd
 * before the route body ran at all, regardless of scope. Switched to
 * `resolveEffectiveDid` (the same dual-guard shape `connections:read` /
 * `connections:write` already use, #1812/#1814): it tries an
 * `attestations:write`-scoped app token (or legacy X-App-DID headers)
 * first and falls back to a direct user session, so both a browser session
 * and a registered app acting on the subject's behalf can countersign.
 *
 * Body: { attestationId: string, witnessJws: string }
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await resolveEffectiveDid(request, { scope: 'attestations:write' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
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
  if (auth.effectiveDid !== att.subjectDid) {
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
      witnessJws,
      attestationStatus: 'bilateral',
    })
    .where(eq(attestations.id, attestationId));

  return NextResponse.json({
    id: attestationId,
    cid: att.cid,
    status: 'bilateral',
  }, { headers: cors });
}
