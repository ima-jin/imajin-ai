import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { and, eq, isNull } from 'drizzle-orm';
import { resolveCallerDid } from '../../caller-did';

/**
 * POST /api/attestations/:id/revoke (#2649)
 *
 * Issuer-only withdrawal of an attestation: stamps `revokedAt` (no schema
 * change — the column already exists and the list read path already filters
 * on it). Callable with a session cookie, a legacy Bearer token, or a
 * session-scoped app token (#2394) — whichever resolves to the DID that
 * issued the attestation (or, for a delegated attestation, the delegator
 * the issuer acted for).
 *
 * The dynamic segment is named `did` only because Next.js requires sibling
 * dynamic segments to share a slug name (GET /api/attestations/:did lives
 * next door); here it carries the attestation id.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);

  const callerDid = await resolveCallerDid(request);
  if (!callerDid) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
  }

  const { did: rawId } = await params;
  const attestationId = decodeURIComponent(rawId);

  const [att] = await db
    .select({
      id: attestations.id,
      issuerDid: attestations.issuerDid,
      delegatorDid: attestations.delegatorDid,
      revokedAt: attestations.revokedAt,
    })
    .from(attestations)
    .where(eq(attestations.id, attestationId))
    .limit(1);
  if (!att) {
    return NextResponse.json({ error: 'Attestation not found' }, { status: 404, headers: cors });
  }

  // A scoped app token (#2394) resolves to the *user* who minted it, while an
  // app-issued attestation carries the app's DID as `issuerDid` and the user
  // as `delegatorDid`. The delegator is the principal the issuer acted for,
  // so it counts as the issuer here; nobody else may revoke.
  const isIssuer = att.issuerDid === callerDid || att.delegatorDid === callerDid;
  if (!isIssuer) {
    return NextResponse.json(
      { error: 'Only the attestation issuer can revoke' },
      { status: 403, headers: cors }
    );
  }

  if (att.revokedAt) {
    return NextResponse.json({ error: 'Attestation is already revoked' }, { status: 409, headers: cors });
  }

  // Guarded on `revoked_at IS NULL` so a concurrent revoke can't overwrite
  // the original revocation timestamp.
  const [revoked] = await db
    .update(attestations)
    .set({ revokedAt: new Date() })
    .where(and(eq(attestations.id, attestationId), isNull(attestations.revokedAt)))
    .returning({ id: attestations.id, revokedAt: attestations.revokedAt });
  if (!revoked) {
    return NextResponse.json({ error: 'Attestation is already revoked' }, { status: 409, headers: cors });
  }

  return NextResponse.json({ id: revoked.id, revokedAt: revoked.revokedAt }, { headers: cors });
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
