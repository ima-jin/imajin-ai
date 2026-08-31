import { NextRequest, NextResponse } from 'next/server';
import { db, identities, attestations, tokens, attestationTypeRegistry } from '@/src/db';
import type { Attestation } from '@/src/db';
import { eq, and, isNull, gt, desc, notInArray, inArray } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { canonicalize, crypto as authCrypto, ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES, evidenceGradeForAttestationStatus, isDisclosureScope } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';
import { computeCid } from '@imajin/cid';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { randomUUID } from 'node:crypto';
import { resolveIssuedAt, validateNostrKeyBinding, deriveOriginUrl, resolveEnvelopeFields, verifyDelegatedAttestation } from './attestation-helpers';
import { isRegisteredAttestationType } from '@/src/lib/auth/attestation-type-registry';
import { trustRadius } from '@imajin/trust-graph';
import { resolveDisclosureAccess } from '@/src/lib/auth/disclosure-access';

const ATTESTATION_LIMIT_MAX = 100;

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

type EnvelopeResolution = ReturnType<typeof resolveEnvelopeFields>;

/**
 * Resolve + validate the intro-funnel envelope fields carried in `payload`,
 * including that `prev_event_ref` (when present) resolves to an existing
 * attestation. Extracted from POST so the handler's own branching stays
 * under the cognitive-complexity budget (#1885).
 */
async function resolveEnvelope(payload: unknown): Promise<EnvelopeResolution> {
  const envelopeResult = resolveEnvelopeFields(payload);
  if (!envelopeResult.ok) return envelopeResult;

  const { prevEventRef } = envelopeResult.envelope;
  if (!prevEventRef) return envelopeResult;

  const [predecessor] = await db.select({ id: attestations.id }).from(attestations).where(eq(attestations.id, prevEventRef)).limit(1);
  if (!predecessor) {
    return { ok: false, error: `prev_event_ref "${prevEventRef}" does not reference an existing attestation` };
  }
  return envelopeResult;
}

type IssuerAndDelegationResult =
  | { ok: true; grantId: string | null }
  | { ok: false; status: number; error: string };

/**
 * Resolve the issuer's public key, verify the Ed25519 signature over the
 * canonical payload, and — when the envelope asserts delegator_did — verify
 * the backing delegation grant (#1895, #1897). Extracted from POST so the
 * handler's own branching stays under the cognitive-complexity budget
 * (#1885).
 */
async function verifyIssuerAndDelegation(params: {
  issuerDid: string;
  subjectDid: string;
  type: string;
  canonicalPayload: string;
  signature: string;
  delegatorDid: string | null;
}): Promise<IssuerAndDelegationResult> {
  const [issuerIdentity] = await db
    .select({ publicKey: identities.publicKey })
    .from(identities)
    .where(eq(identities.id, params.issuerDid))
    .limit(1);

  if (!issuerIdentity) {
    return { ok: false, status: 400, error: 'Issuer DID not found' };
  }

  const sigValid = authCrypto.verifySync(params.signature, params.canonicalPayload, issuerIdentity.publicKey);
  if (!sigValid) {
    return { ok: false, status: 400, error: 'Invalid signature' };
  }

  // A self-asserted delegator_did is not proof of delegation — verify a
  // live grant actually backs it before minting a "delegated" fact into
  // the honest record.
  const delegationCheck = await verifyDelegatedAttestation({
    delegatorDid: params.delegatorDid,
    issuerDid: params.issuerDid,
    subjectDid: params.subjectDid,
    type: params.type,
  });
  if (!delegationCheck.ok) {
    return { ok: false, status: 403, error: delegationCheck.error };
  }

  return { ok: true, grantId: delegationCheck.grantId };
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
 * Body: { issuer_did, subject_did, type, context_id?, context_type?, payload?, signature, issued_at?, nostr_sig? }
 *
 * Signature MUST be Ed25519 over:
 *   canonicalize({ subject_did, type, context_id, context_type, payload, issued_at })
 *
 * For type `imajin/nostr-key-binding` only:
 *   nostr_sig MUST be a secp256k1 Schnorr (BIP-340) signature by the key in
 *   payload.nostr_pubkey over SHA-256(canonicalize(...)). Both sigs cover the
 *   same canonical form, proving control of both the DID and the Nostr key.
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

  const isKnownType = (ATTESTATION_TYPES as readonly string[]).includes(type) || (await isRegisteredAttestationType(type));
  if (!isKnownType) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ATTESTATION_TYPES.join(', ')}, or a type registered via /auth/api/attestations/types` },
      { status: 400, headers: cors }
    );
  }

  // Intro-funnel envelope fields (#1885) ride inside `payload`, which is
  // already part of the signed canonical form below — see resolveEnvelope.
  const envelopeResult = await resolveEnvelope(payload);
  if (!envelopeResult.ok) {
    return NextResponse.json({ error: envelopeResult.error }, { status: 400, headers: cors });
  }
  const { delegatorDid, disclosureScope, prevEventRef } = envelopeResult.envelope;

  const issuedAtMs = resolveIssuedAt(issued_at);

  // Canonical form that was signed
  const canonicalPayload = canonicalize({
    subject_did,
    type,
    context_id: context_id ?? null,
    context_type: context_type ?? null,
    payload: payload ?? null,
    issued_at: issuedAtMs,
  });

  const verification = await verifyIssuerAndDelegation({
    issuerDid: issuer_did,
    subjectDid: subject_did,
    type,
    canonicalPayload,
    signature,
    delegatorDid,
  });
  if (!verification.ok) {
    return NextResponse.json({ error: verification.error }, { status: verification.status, headers: cors });
  }

  // For imajin/nostr-key-binding: require + verify the Nostr key's Schnorr signature
  // proving the submitter also controls the Nostr key they are binding.
  let nostrSigToStore: string | null = null;
  if (type === 'imajin/nostr-key-binding') {
    const nostrResult = validateNostrKeyBinding(body.nostr_sig, payload, canonicalPayload);
    if (!nostrResult.ok) {
      return NextResponse.json({ error: nostrResult.error }, { status: 400, headers: cors });
    }
    nostrSigToStore = nostrResult.nostrSigToStore;
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
      subjectDid: subject_did,
      type: type as AttestationType,
      contextId: (context_id as string | undefined) ?? null,
      contextType: (context_type as string | undefined) ?? null,
      payload: (payload as Record<string, unknown> | undefined) ?? null,
      signature,
      cid,
      nostrSig: nostrSigToStore,
      authorJws,
      attestationStatus: authorJws ? 'pending' : null, // null for legacy attestations
      delegatorDid,
      disclosureScope,
      prevEventRef,
      delegationGrantId: verification.grantId,
      issuedAt: new Date(issuedAtMs),
    })
    .returning();

  publish('attestation.created', {
    issuer: issuer_did,
    subject: subject_did,
    scope: 'auth',
    payload: {
      attestationId: attestation.id,
      type,
      issuerDid: issuer_did,
      subjectDid: subject_did,
      contextId: (context_id as string | undefined) ?? null,
      contextType: (context_type as string | undefined) ?? null,
      originUrl: deriveOriginUrl(request),
      pendingSignature: Boolean(authorJws),
    },
  }).catch(() => {});

  return NextResponse.json(attestation, { status: 201, headers: cors });
}

// evidence_grade is the public-facing name for the countersign/decline
// state machine (#1885); `status` (the raw attestationStatus values) is
// kept for backward compatibility.
const EVIDENCE_GRADE_TO_STATUS: Record<string, string> = {
  unilateral: 'pending',
  corroborated: 'bilateral',
  disputed: 'declined',
};

/**
 * GET /api/attestations?subject_did=...&type=...&issuer_did=...&limit=...&evidence_grade=...
 * Returns non-revoked attestations for a subject, newest first, annotated
 * with a computed `evidenceGrade`.
 * subject_did is required.
 *
 * disclosure_scope (#1885) is enforced only for attestation types present in
 * the attestation_type_registry (i.e. the new envelope-aware vocabulary —
 * platform-seeded funnel types and third-party registered types). The ~59
 * pre-existing hardcoded types keep today's unrestricted query behavior, so
 * this stays anonymous-callable for legacy use cases.
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
  const evidenceGradeFilter = searchParams.get('evidence_grade'); // 'unilateral' | 'corroborated' | 'disputed'
  const statusFilter = searchParams.get('status') ?? // 'pending' | 'bilateral' | 'declined'
    (evidenceGradeFilter ? EVIDENCE_GRADE_TO_STATUS[evidenceGradeFilter] : null);
  const limitParam = Number.parseInt(searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(Math.max(1, Number.isNaN(limitParam) ? 20 : limitParam), ATTESTATION_LIMIT_MAX);

  const conditions = [
    eq(attestations.subjectDid, subjectDid),
    isNull(attestations.revokedAt),
  ];
  if (typeFilter) conditions.push(eq(attestations.type, typeFilter));
  if (issuerFilter) conditions.push(eq(attestations.issuerDid, issuerFilter));
  if (statusFilter) conditions.push(eq(attestations.attestationStatus, statusFilter));
  // #1822: an untyped `status=pending` query is the "pending your
  // countersignature" view — exclude mechanical audit-record types (e.g.
  // session.created) that were never awaiting anyone's signature. A caller
  // that explicitly asks for a mechanical type (`type=session.created`) still
  // gets it back; this only guards the broad, no-type-filter dashboard query.
  if (statusFilter === 'pending' && !typeFilter) {
    conditions.push(notInArray(attestations.type, [...MECHANICAL_ATTESTATION_TYPES]));
  }

  try {
    const rows = await db
      .select()
      .from(attestations)
      .where(and(...conditions))
      .orderBy(desc(attestations.issuedAt))
      .limit(limit);

    const distinctTypes: string[] = Array.from(new Set(rows.map((row: Attestation): string => row.type)));
    const registeredTypeRows: { typeName: string }[] = distinctTypes.length
      ? await db
          .select({ typeName: attestationTypeRegistry.typeName })
          .from(attestationTypeRegistry)
          .where(and(inArray(attestationTypeRegistry.typeName, distinctTypes), isNull(attestationTypeRegistry.revokedAt)))
      : [];
    const registryGatedTypes = new Set(registeredTypeRows.map((row) => row.typeName));

    let visibleRows = rows;
    if (registryGatedTypes.size > 0) {
      const viewerDid = await resolveCallerDid(request);
      const connectedDids = viewerDid ? await trustRadius(db, viewerDid, 1) : null;
      visibleRows = rows.filter((row: Attestation) => {
        if (!registryGatedTypes.has(row.type)) return true; // legacy type — unrestricted, unchanged behavior
        const scope = isDisclosureScope(row.disclosureScope) ? row.disclosureScope : 'parties';
        return resolveDisclosureAccess(
          scope,
          viewerDid,
          { subjectDid: row.subjectDid, actorDid: row.issuerDid, delegatorDid: row.delegatorDid },
          connectedDids,
        );
      });
    }

    const annotatedRows = visibleRows.map((row: Attestation) => ({
      ...row,
      evidenceGrade: evidenceGradeForAttestationStatus(row.attestationStatus),
    }));

    return NextResponse.json(annotatedRows, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Attestations GET error');
    return NextResponse.json({ error: 'Failed to query attestations' }, { status: 500, headers: cors });
  }
});
