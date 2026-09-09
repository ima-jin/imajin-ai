import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { eq } from 'drizzle-orm';
import { resolveEffectiveDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { checkSupersessionEligibility, SupersessionError } from '../attestation-helpers';
import { verifyWitnessJws } from '@/src/lib/auth/witness-jws';

const log = createLogger('kernel:countersign');

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

  // #2083: verify witnessJws for real before anything is persisted — a
  // real Ed25519/EdDSA signature by the subject's (the witness's) resolved
  // DID key, over a payload that names this exact attestation's id + CID.
  // Fails closed: any rejection (alg not allow-listed, unresolvable
  // witness DID, bad signature, or a CID/attestationId that doesn't match)
  // returns 422 without ever reaching the update below.
  const witnessVerification = await verifyWitnessJws({
    witnessJws,
    witnessDid: auth.effectiveDid,
    attestationId,
    cid: att.cid,
  });
  if (!witnessVerification.ok) {
    // Abuse-monitoring signal only — never logs witnessJws or key material,
    // just which attestation/witness pair failed verification and why.
    log.warn(
      { attestationId, witnessDid: auth.effectiveDid, reason: witnessVerification.error },
      'countersign rejected: witnessJws verification failed'
    );
    return NextResponse.json({ error: witnessVerification.error }, { status: 422, headers: cors });
  }

  // Amendment-by-supersession (#1790): when this attestation proposes to
  // amend an earlier one, flip both rows atomically — v1 (referenced by
  // `supersedes`) -> 'superseded', v2 (this one) -> 'bilateral' — so a
  // reader can never observe a bilateral v2 whose v1 hasn't (yet) been
  // retired, or vice versa. Re-verifies eligibility *inside* the
  // transaction against a fresh read (not the creation-time check, which
  // could be stale by now) to close the TOCTOU gap between proposing the
  // amendment and it going bilateral. Follows the db.transaction() pattern
  // established by promote-actor.ts.
  if (att.supersedes) {
    try {
      await db.transaction(async (tx) => {
        const [v1] = await tx.select().from(attestations).where(eq(attestations.id, att.supersedes as string)).limit(1);
        if (!v1) {
          throw new SupersessionError(`supersedes "${att.supersedes}" does not reference an existing attestation`, 404);
        }
        const eligibility = checkSupersessionEligibility(v1, att.issuerDid);
        if (!eligibility.ok) {
          throw new SupersessionError(eligibility.error, 409);
        }

        await tx.update(attestations)
          .set({ attestationStatus: 'superseded' })
          .where(eq(attestations.id, v1.id));

        await tx.update(attestations)
          .set({
            witnessJws,
            attestationStatus: 'bilateral',
          })
          .where(eq(attestations.id, attestationId));
      });
    } catch (err) {
      if (err instanceof SupersessionError) {
        return NextResponse.json({ error: err.message }, { status: err.status, headers: cors });
      }
      throw err;
    }
  } else {
    await db.update(attestations)
      .set({
        witnessJws,
        attestationStatus: 'bilateral',
      })
      .where(eq(attestations.id, attestationId));
  }

  return NextResponse.json({
    id: attestationId,
    cid: att.cid,
    status: 'bilateral',
  }, { headers: cors });
}
