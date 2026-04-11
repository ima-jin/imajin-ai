import { NextRequest, NextResponse } from 'next/server';
import { db, identities, attestations, tokens } from '@/src/db';
import { eq, and, isNull, gt, desc } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { canonicalize, crypto as authCrypto, ATTESTATION_TYPES } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';
import { computeCid } from '@imajin/cid';
import { withLogger } from '@imajin/logger';
import { createEmitter } from '@imajin/events';

const events = createEmitter('auth');

const ATTESTATION_LIMIT_MAX = 100;

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

/** Resolve calling identity from session cookie or Bearer token */
async function resolveCallerDid(request: NextRequest): Promise<string | null> {
  const cookieConfig = getSessionCookieOptions();
  const sessionToken = request.cookies.get(cookieConfig.name)?.value;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    if (session?.sub) return session.sub;
  }

  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const [tok] = await db
      .select({ identityId: tokens.identityId })
      .from(tokens)
      .where(
        and(
          eq(tokens.id, token),
          isNull(tokens.revokedAt),
          gt(tokens.expiresAt, new Date())
        )
      )
      .limit(1);
    if (tok?.identityId) return tok.identityId;
  }

  return null;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/attestations
 * Issue a new attestation.
 * Requires session cookie or Bearer token.
 *
 * Body: { issuer_did, subject_did, type, context_id?, context_type?, payload?, signature, issued_at? }
 *
 * Signature MUST be Ed25519 over:
 *   canonicalize({ subject_did, type, context_id, context_type, payload, issued_at })
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const callerDid = await resolveCallerDid(request);
  if (!callerDid) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { issuer_did, subject_did, type, context_id, context_type, payload, signature, issued_at } = body;

  if (!issuer_did || typeof issuer_did !== 'string') {
    return NextResponse.json({ error: 'issuer_did required' }, { status: 400, headers: cors });
  }
  if (!subject_did || typeof subject_did !== 'string') {
    return NextResponse.json({ error: 'subject_did required' }, { status: 400, headers: cors });
  }
  if (!type || typeof type !== 'string') {
    return NextResponse.json({ error: 'type required' }, { status: 400, headers: cors });
  }
  if (!signature || typeof signature !== 'string') {
    return NextResponse.json({ error: 'signature required' }, { status: 400, headers: cors });
  }

  if (!(ATTESTATION_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ATTESTATION_TYPES.join(', ')}` },
      { status: 400, headers: cors }
    );
  }

  // Resolve issuer's public key
  const [issuerIdentity] = await db
    .select({ publicKey: identities.publicKey })
    .from(identities)
    .where(eq(identities.id, issuer_did))
    .limit(1);

  if (!issuerIdentity) {
    return NextResponse.json({ error: 'Issuer DID not found' }, { status: 400, headers: cors });
  }

  const issuedAtMs = issued_at
    ? (typeof issued_at === 'number' ? issued_at : new Date(issued_at as string).getTime())
    : Date.now();

  // Canonical form that was signed
  const canonicalPayload = canonicalize({
    subject_did,
    type,
    context_id: context_id ?? null,
    context_type: context_type ?? null,
    payload: payload ?? null,
    issued_at: issuedAtMs,
  });

  const sigValid = authCrypto.verifySync(signature, canonicalPayload, issuerIdentity.publicKey);
  if (!sigValid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400, headers: cors });
  }

  const id = genId('att');

  // Compute content address (CID) for the attestation payload
  const cidPayload = {
    issuerDid: issuer_did,
    subjectDid: subject_did,
    type,
    contextId: context_id ?? null,
    contextType: context_type ?? null,
    payload: payload ?? null,
    issuedAt: issuedAtMs,
  };
  let cid: string | null = null;
  try {
    cid = await computeCid(cidPayload);
  } catch {
    // Non-fatal — old-style attestation still works without CID
  }

  // Accept optional author_jws for new-style bilateral attestations
  const authorJws = (body.author_jws as string | undefined) ?? null;

  const [attestation] = await db
    .insert(attestations)
    .values({
      id,
      issuerDid: issuer_did,
      subjectDid: subject_did as string,
      type: type as AttestationType,
      contextId: (context_id as string | undefined) ?? null,
      contextType: (context_type as string | undefined) ?? null,
      payload: (payload as Record<string, unknown> | undefined) ?? null,
      signature,
      cid,
      authorJws,
      attestationStatus: authorJws ? 'pending' : null, // null for legacy attestations
      issuedAt: new Date(issuedAtMs),
    })
    .returning();

  events.emit({ action: 'attestation.create', did: issuer_did as string, payload: { attestationId: attestation.id, type, subjectDid: subject_did as string } });

  return NextResponse.json(attestation, { status: 201, headers: cors });
}

/**
 * GET /api/attestations?subject_did=...&type=...&issuer_did=...&limit=...
 * Returns non-revoked attestations for a subject, newest first.
 * subject_did is required.
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);
  const { searchParams } = new URL(request.url);

  const subjectDid = searchParams.get('subject_did');
  if (!subjectDid) {
    return NextResponse.json({ error: 'subject_did required' }, { status: 400, headers: cors });
  }

  const typeFilter = searchParams.get('type');
  const issuerFilter = searchParams.get('issuer_did');
  const statusFilter = searchParams.get('status'); // 'pending' | 'bilateral' | 'declined'
  const limitParam = parseInt(searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 20 : limitParam), ATTESTATION_LIMIT_MAX);

  const conditions = [
    eq(attestations.subjectDid, subjectDid),
    isNull(attestations.revokedAt),
  ];
  if (typeFilter) conditions.push(eq(attestations.type, typeFilter));
  if (issuerFilter) conditions.push(eq(attestations.issuerDid, issuerFilter));
  if (statusFilter) conditions.push(eq(attestations.attestationStatus, statusFilter));

  try {
    const rows = await db
      .select()
      .from(attestations)
      .where(and(...conditions))
      .orderBy(desc(attestations.issuedAt))
      .limit(limit);

    return NextResponse.json(rows, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Attestations GET error');
    return NextResponse.json({ error: 'Failed to query attestations' }, { status: 500, headers: cors });
  }
});
