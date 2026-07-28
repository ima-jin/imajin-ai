/**
 * GET /api/attestations/nostr/:npub
 *
 * Resolver for `imajin/nostr-key-binding` attestations.
 *
 * Given a bech32-encoded npub, returns the bound DID and validity status:
 *   - valid: true  → active binding, returns `did`
 *   - valid: false → no binding, expired, or revoked; returns `reason`
 *
 * Validity checks (in order):
 *   1. At least one non-revoked `imajin/nostr-key-binding` attestation exists for the npub
 *   2. The most-recent such attestation has not expired (claim.expires_at or row expiresAt)
 *   3. The stored signature is intact (tampered claim → invalid)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, identities } from '@/src/db';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { NostrKeyBindingClaim } from '@imajin/auth';

const NOSTR_KEY_BINDING_TYPE = 'imajin/nostr-key-binding';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ npub: string }> }
) {
  const cors = corsHeaders(request);
  const { npub } = await params;
  const decodedNpub = decodeURIComponent(npub);

  if (!decodedNpub.startsWith('npub1')) {
    return NextResponse.json(
      { valid: false, reason: 'Invalid npub: must start with npub1' },
      { status: 400, headers: cors }
    );
  }

  // Find the most-recent non-revoked binding for this npub.
  // The npub is stored inside the JSONB payload field.
  const rows = await db
    .select()
    .from(attestations)
    .where(
      and(
        eq(attestations.type, NOSTR_KEY_BINDING_TYPE),
        isNull(attestations.revokedAt),
        sql`${attestations.payload}->>'npub' = ${decodedNpub}`
      )
    )
    .orderBy(desc(attestations.issuedAt))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json(
      { valid: false, reason: 'No binding found for this npub' },
      { status: 404, headers: cors }
    );
  }

  const attestation = rows[0]!;
  const claim = attestation.payload as NostrKeyBindingClaim | null;

  // Check expiry: prefer claim-level expires_at, fall back to row-level expiresAt
  const expiresAtMs =
    claim?.expires_at ??
    (attestation.expiresAt ? attestation.expiresAt.getTime() : null);

  if (expiresAtMs !== null && expiresAtMs !== undefined && Date.now() > expiresAtMs) {
    return NextResponse.json(
      { valid: false, reason: 'Binding has expired' },
      { status: 200, headers: cors }
    );
  }

  // Verify signature integrity to detect tampered claims.
  // The canonical payload matches what was signed at mint time.
  const [issuerIdentity] = await db
    .select({ publicKey: identities.publicKey })
    .from(identities)
    .where(eq(identities.id, attestation.issuerDid))
    .limit(1);

  if (issuerIdentity) {
    const issuedAtMs =
      attestation.issuedAt instanceof Date
        ? attestation.issuedAt.getTime()
        : new Date(attestation.issuedAt).getTime();

    const canonicalPayload = canonicalize({
      subject_did: attestation.subjectDid,
      type: attestation.type,
      context_id: attestation.contextId ?? null,
      context_type: attestation.contextType ?? null,
      payload: attestation.payload ?? null,
      issued_at: issuedAtMs,
    });

    const sigValid = authCrypto.verifySync(
      attestation.signature,
      canonicalPayload,
      issuerIdentity.publicKey
    );

    if (!sigValid) {
      return NextResponse.json(
        { valid: false, reason: 'Signature verification failed — claim may be tampered' },
        { status: 200, headers: cors }
      );
    }
  }

  return NextResponse.json(
    {
      valid: true,
      did: attestation.subjectDid,
      attestation: {
        id: attestation.id,
        issuerDid: attestation.issuerDid,
        subjectDid: attestation.subjectDid,
        type: attestation.type,
        payload: attestation.payload,
        issuedAt: attestation.issuedAt,
        expiresAt: attestation.expiresAt ?? null,
      },
    },
    { status: 200, headers: cors }
  );
}
