import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationTypeRegistry } from '@/src/db';
import type { Attestation } from '@/src/db';
import { eq, and, isNull, ne, desc, notInArray, inArray, sql } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { canonicalize, crypto as authCrypto, ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES, KEY_ROTATED_ATTESTATION_TYPE, evidenceGradeForAttestationStatus, isDisclosureScope } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';
import { computeCid } from '@imajin/cid';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { randomUUID } from 'node:crypto';
import { resolveIssuedAt, validateNostrKeyBinding, deriveOriginUrl, resolveEnvelopeFields, verifyDelegatedAttestation, validateSupersedesReference, resolveAttestationHistory, resolveIssuerCredentials, SupersessionError } from './attestation-helpers';
import type { EnvelopeFields } from './attestation-helpers';
import { resolveCallerDid, resolveCallerIdentity, ATTESTATIONS_WRITE_SCOPE } from './caller-did';
import { isRegisteredAttestationType } from '@/src/lib/auth/attestation-type-registry';
import { trustRadius } from '@imajin/trust-graph';
import { resolveDisclosureAccess } from '@/src/lib/auth/disclosure-access';
import { encodeAttestationCursor, parseAttestationCursor } from './attestation-cursor';
import type { AttestationCursor } from './attestation-cursor';

const ATTESTATION_LIMIT_MAX = 100;
const ATTESTATION_REF_MAX_LENGTH = 256;
/** Response header carrying the cursor for the next (older) page — see GET. */
const NEXT_CURSOR_HEADER = 'X-Next-Cursor';

type RefResolution = { ok: true; ref: string | null } | { ok: false; error: string };

/**
 * Validate the optional `ref` on POST (#2534): absent/null -> null; otherwise a
 * non-empty string of at most ATTESTATION_REF_MAX_LENGTH chars. It is an opaque
 * lookup key, so no further shape is imposed.
 */
function resolveRef(value: unknown): RefResolution {
  if (value === undefined || value === null) return { ok: true, ref: null };
  if (typeof value !== 'string' || value.length === 0 || value.length > ATTESTATION_REF_MAX_LENGTH) {
    return { ok: false, error: `ref must be a non-empty string of at most ${ATTESTATION_REF_MAX_LENGTH} characters` };
  }
  return { ok: true, ref: value };
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

type EnvelopeResolution =
  | { ok: true; envelope: EnvelopeFields; supersedesOneSided: boolean }
  | { ok: false; error: string };

/**
 * Resolve + validate the intro-funnel envelope fields carried in `payload`,
 * including that `prev_event_ref` (when present) resolves to an existing
 * attestation, and that `supersedes` (when present) resolves either to a
 * bilateral attestation `proposerDid` is a party to (#1790 — amendment-by-
 * supersession; deliberately a separate check from prevEventRef, see
 * attestation-helpers) or to a one-sided attestation issued by the same
 * `proposerDid` (#2649 — the old row is retired immediately on write, so the
 * replacement must itself be one-sided, i.e. carry no `author_jws`).
 * Extracted from POST so the handler's own branching stays under the
 * cognitive-complexity budget (#1885).
 */
async function resolveEnvelope(payload: unknown, proposerDid: string, hasAuthorJws: boolean): Promise<EnvelopeResolution> {
  const envelopeResult = resolveEnvelopeFields(payload);
  if (!envelopeResult.ok) return envelopeResult;

  const { prevEventRef, supersedes } = envelopeResult.envelope;

  if (prevEventRef) {
    const [predecessor] = await db.select({ id: attestations.id }).from(attestations).where(eq(attestations.id, prevEventRef)).limit(1);
    if (!predecessor) {
      return { ok: false, error: `prev_event_ref "${prevEventRef}" does not reference an existing attestation` };
    }
  }

  let supersedesOneSided = false;
  if (supersedes) {
    const supersedesResult = await validateSupersedesReference(supersedes, proposerDid, { allowOneSided: true });
    if (!supersedesResult.ok) return supersedesResult;
    supersedesOneSided = supersedesResult.oneSided === true;
    if (supersedesOneSided && hasAuthorJws) {
      return { ok: false, error: 'author_jws cannot be combined with supersedes on a one-sided attestation' };
    }
  }

  return { ...envelopeResult, supersedesOneSided };
}

type PersistResult =
  | { ok: true; attestation: Attestation }
  | { ok: false; status: number; error: string };

/**
 * Insert the new attestation. When it replaces a one-sided attestation
 * (#2649), flip the old row to `superseded` in the same transaction — guarded
 * on issuer / still-one-sided / not-revoked so a concurrent supersede or
 * revoke can't be overwritten (the update then matches zero rows and the
 * whole transaction rolls back with a 409). Extracted from POST to keep the
 * handler's own branching under the cognitive-complexity budget.
 */
async function persistAttestation(
  values: typeof attestations.$inferInsert,
  retireOneSidedId: string | null,
): Promise<PersistResult> {
  if (!retireOneSidedId) {
    const [attestation] = await db.insert(attestations).values(values).returning();
    return { ok: true, attestation };
  }

  try {
    const attestation = await db.transaction(async (tx) => {
      const retired = await tx
        .update(attestations)
        .set({ attestationStatus: 'superseded' })
        .where(
          and(
            eq(attestations.id, retireOneSidedId),
            eq(attestations.issuerDid, values.issuerDid),
            isNull(attestations.attestationStatus),
            isNull(attestations.revokedAt),
          ),
        )
        .returning({ id: attestations.id });
      if (retired.length === 0) {
        throw new SupersessionError(
          `supersedes "${retireOneSidedId}" is no longer an active one-sided attestation`,
          409,
        );
      }

      const [inserted] = await tx.insert(attestations).values(values).returning();
      return inserted;
    });
    return { ok: true, attestation };
  } catch (err) {
    if (err instanceof SupersessionError) {
      return { ok: false, status: err.status, error: err.message };
    }
    throw err;
  }
}

/**
 * Authenticate the caller of POST — 401 without a usable credential — and
 * (#2764) require an app's own service token to carry `attestations:write`:
 * a verified token without it is a terminal 403, before anything is read or
 * written. User sessions, legacy Bearer tokens and session-app tokens have no
 * service scope set and are not scope-gated. Returns the rejection response,
 * or null when the caller may write.
 */
async function rejectUnauthorizedWrite(request: NextRequest, cors: HeadersInit): Promise<NextResponse | null> {
  const caller = await resolveCallerIdentity(request);
  if (!caller) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
  }
  if (caller.serviceScopes && !caller.serviceScopes.includes(ATTESTATIONS_WRITE_SCOPE)) {
    return NextResponse.json({ error: `Missing required scope: ${ATTESTATIONS_WRITE_SCOPE}` }, { status: 403, headers: cors });
  }
  return null;
}

/**
 * Gate on the submitted `type`: it must be a known attestation type (compile-
 * time list or live registry entry), and not one only the node may mint.
 * `key.rotated` (#2081) is the node's own key-history record — filed solely
 * by the node identity via the rotation ceremony, never by a caller.
 * Returns the rejection response, or null when the type may be submitted.
 */
async function rejectUnsubmittableType(type: string, cors: HeadersInit): Promise<NextResponse | null> {
  const isKnownType = (ATTESTATION_TYPES as readonly string[]).includes(type) || (await isRegisteredAttestationType(type));
  if (!isKnownType) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ATTESTATION_TYPES.join(', ')}, or a type registered via /auth/api/attestations/types` },
      { status: 400, headers: cors }
    );
  }
  if (type === KEY_ROTATED_ATTESTATION_TYPE) {
    return NextResponse.json({ error: `Attestation type "${type}" is node-issued only` }, { status: 403, headers: cors });
  }
  return null;
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
  const issuer = await resolveIssuerCredentials(params.issuerDid);
  if (!issuer) {
    return { ok: false, status: 400, error: 'Issuer DID not found' };
  }

  const sigValid = authCrypto.verifySync(params.signature, params.canonicalPayload, issuer.publicKey);
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
    issuerAppId: issuer.appId,
  });
  if (!delegationCheck.ok) {
    return { ok: false, status: 403, error: delegationCheck.error };
  }

  return { ok: true, grantId: delegationCheck.grantId };
}

type NostrResolution = { ok: true; nostrSig: string | null } | { ok: false; error: string };

/**
 * For `imajin/nostr-key-binding` only: require + verify the Nostr key's
 * Schnorr signature proving the submitter also controls the Nostr key they
 * are binding. A no-op for every other type. Extracted from POST to keep the
 * handler's own branching under the cognitive-complexity budget.
 */
function resolveNostrSignature(
  type: string,
  nostrSig: unknown,
  payload: unknown,
  canonicalPayload: string,
): NostrResolution {
  if (type !== 'imajin/nostr-key-binding') return { ok: true, nostrSig: null };
  const nostrResult = validateNostrKeyBinding(nostrSig, payload, canonicalPayload);
  return nostrResult.ok ? { ok: true, nostrSig: nostrResult.nostrSigToStore } : { ok: false, error: nostrResult.error };
}

/**
 * POST /api/attestations
 * Issue a new attestation.
 * Requires session cookie or Bearer token.
 *
 * Body: { issuer_did, subject_did, type, context_id?, context_type?, ref?, payload?, signature, issued_at?, nostr_sig? }
 *
 * `ref` (#2534) is an optional, indexed, app-specific lookup key (e.g. a
 * ticketId). It is stored verbatim and is NOT part of the signed canonical
 * form below — the signed `payload` remains the source of truth.
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

  const authRejection = await rejectUnauthorizedWrite(request, cors);
  if (authRejection) return authRejection;

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

  const typeRejection = await rejectUnsubmittableType(type, cors);
  if (typeRejection) return typeRejection;

  // Intro-funnel envelope fields (#1885) ride inside `payload`, which is
  // already part of the signed canonical form below — see resolveEnvelope.
  // The proposer for a `supersedes` reference (#1790) is the issuer of this
  // new attestation, i.e. whoever is signing the amendment. For a one-sided
  // target (#2649) that same issuer retires its own earlier row.
  // author_jws is accepted for new-style bilateral attestations.
  const authorJws = (body.author_jws as string | undefined) ?? null;

  const envelopeResult = await resolveEnvelope(payload, issuer_did, Boolean(authorJws));
  if (!envelopeResult.ok) {
    return NextResponse.json({ error: envelopeResult.error }, { status: 400, headers: cors });
  }
  const { delegatorDid, disclosureScope, prevEventRef, supersedes } = envelopeResult.envelope;
  const retireOneSidedId = envelopeResult.supersedesOneSided ? supersedes : null;

  const refResult = resolveRef(body.ref);
  if (!refResult.ok) {
    return NextResponse.json({ error: refResult.error }, { status: 400, headers: cors });
  }

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

  const nostrResolution = resolveNostrSignature(type, body.nostr_sig, payload, canonicalPayload);
  if (!nostrResolution.ok) {
    return NextResponse.json({ error: nostrResolution.error }, { status: 400, headers: cors });
  }
  const nostrSigToStore = nostrResolution.nostrSig;

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

  const persisted = await persistAttestation(
    {
      id,
      issuerDid: issuer_did,
      subjectDid: subject_did,
      type: type as AttestationType,
      contextId: (context_id as string | undefined) ?? null,
      contextType: (context_type as string | undefined) ?? null,
      ref: refResult.ref,
      payload: (payload as Record<string, unknown> | undefined) ?? null,
      signature,
      cid,
      nostrSig: nostrSigToStore,
      authorJws,
      attestationStatus: authorJws ? 'pending' : null, // null for legacy attestations
      delegatorDid,
      disclosureScope,
      prevEventRef,
      supersedes,
      delegationGrantId: verification.grantId,
      issuedAt: new Date(issuedAtMs),
    },
    retireOneSidedId,
  );
  if (!persisted.ok) {
    return NextResponse.json({ error: persisted.error }, { status: persisted.status, headers: cors });
  }
  const { attestation } = persisted;

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

type CursorResolution = { ok: true; cursor: AttestationCursor | null } | { ok: false; error: string };

/** Parse the optional `before` query param (#2533); absent -> first page. */
function resolveCursor(beforeParam: string | null): CursorResolution {
  if (!beforeParam) return { ok: true, cursor: null };
  const cursor = parseAttestationCursor(beforeParam);
  return cursor ? { ok: true, cursor } : { ok: false, error: 'before must be <issued_at,id>' };
}

/**
 * Split a `limit + 1` fetch into the page and the cursor for the next one.
 * The cursor comes from the last row of the DB page, before any
 * disclosure_scope filtering, so a page that loses rows to that filter still
 * advances.
 */
function splitPage(fetched: Attestation[], limit: number): { rows: Attestation[]; nextCursor: string | null } {
  if (fetched.length <= limit) return { rows: fetched, nextCursor: null };
  const rows = fetched.slice(0, limit);
  return { rows, nextCursor: encodeAttestationCursor(rows.at(-1) as Attestation) };
}

/**
 * issued_at truncated to the millisecond. The cursor carries a JS timestamp
 * (ms precision) but rows written with the column default (`now()`) have
 * microsecond precision; truncating on both the ORDER BY and the cursor
 * comparison keeps the two consistent so no row is skipped or repeated
 * across a page boundary.
 */
const issuedAtTruncated = () => sql`date_trunc('milliseconds', ${attestations.issuedAt})`;

/** Keyset predicate (#2533): strictly older than the cursor row in (issued_at DESC, id DESC) order. */
function beforeCursorCondition(cursor: AttestationCursor) {
  return sql`(${issuedAtTruncated()}, ${attestations.id}) < (${cursor.issuedAt}::timestamptz, ${cursor.id})`;
}

/**
 * Build the `and(...)` condition list for the GET list query. Extracted
 * from GET so the handler's own branching stays under the
 * cognitive-complexity budget (#1885, #1790).
 */
function buildListConditions(params: {
  subjectDid: string;
  typeFilter: string | null;
  issuerFilter: string | null;
  statusFilter: string | null;
  contextIdFilter: string | null;
  refFilter: string | null;
  cursor: AttestationCursor | null;
}) {
  const { subjectDid, typeFilter, issuerFilter, statusFilter, contextIdFilter, refFilter, cursor } = params;
  const conditions = [
    eq(attestations.subjectDid, subjectDid),
    isNull(attestations.revokedAt),
  ];
  if (typeFilter) conditions.push(eq(attestations.type, typeFilter));
  if (issuerFilter) conditions.push(eq(attestations.issuerDid, issuerFilter));
  // #2396: exact match on the indexed context_id column.
  if (contextIdFilter) conditions.push(eq(attestations.contextId, contextIdFilter));
  // #2534: exact match on the indexed ref column. Never a payload query.
  if (refFilter) conditions.push(eq(attestations.ref, refFilter));
  if (cursor) conditions.push(beforeCursorCondition(cursor));
  if (statusFilter) {
    conditions.push(eq(attestations.attestationStatus, statusFilter));
  } else {
    // #1790: reads default to operative records — a superseded v1 is still
    // readable by id/history (resolveAttestationHistory, history_of above)
    // but shouldn't clutter the default "current state" list view. A caller
    // that explicitly asks for `status=superseded` (or evidence_grade) still
    // gets it back, since that branch is skipped whenever statusFilter is set.
    conditions.push(ne(attestations.attestationStatus, 'superseded'));
  }
  // #1822: an untyped `status=pending` query is the "pending your
  // countersignature" view — exclude mechanical audit-record types (e.g.
  // session.created) that were never awaiting anyone's signature. A caller
  // that explicitly asks for a mechanical type (`type=session.created`) still
  // gets it back; this only guards the broad, no-type-filter dashboard query.
  if (statusFilter === 'pending' && !typeFilter) {
    conditions.push(notInArray(attestations.type, [...MECHANICAL_ATTESTATION_TYPES]));
  }
  return conditions;
}

/**
 * Apply disclosure_scope access control (#1885) to rows whose `type` is
 * registry-gated, leaving legacy (non-registered) types unrestricted.
 * Extracted from GET so the handler's own branching stays under the
 * cognitive-complexity budget.
 */
async function filterVisibleRows(rows: Attestation[], request: NextRequest): Promise<Attestation[]> {
  const distinctTypes: string[] = Array.from(new Set(rows.map((row: Attestation): string => row.type)));
  const registeredTypeRows: { typeName: string }[] = distinctTypes.length
    ? await db
        .select({ typeName: attestationTypeRegistry.typeName })
        .from(attestationTypeRegistry)
        .where(and(inArray(attestationTypeRegistry.typeName, distinctTypes), isNull(attestationTypeRegistry.revokedAt)))
    : [];
  const registryGatedTypes = new Set(registeredTypeRows.map((row) => row.typeName));
  if (registryGatedTypes.size === 0) return rows;

  const viewerDid = await resolveCallerDid(request);
  const connectedDids = viewerDid ? await trustRadius(db, viewerDid, 1) : null;
  return rows.filter((row: Attestation) => {
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

/**
 * GET /api/attestations?subject_did=...&type=...&issuer_did=...&context_id=...&ref=...&limit=...&evidence_grade=...&before=...
 * Returns non-revoked attestations for a subject, newest first, annotated
 * with a computed `evidenceGrade`.
 * subject_did is required.
 *
 * Cursor paging (#2533): order is (issued_at DESC, id DESC) — stable, with the
 * id as tiebreak for same-timestamp rows. Pass `before=<issued_at,id>` (the
 * value of the previous page's `X-Next-Cursor` response header) to get the
 * next, older page; the header is only present when more rows exist. No
 * offset paging. The body stays a bare array so existing callers are
 * unaffected. `next_cursor` is taken from the last row of the DB page, before
 * disclosure_scope filtering, so a page that loses rows to that filter still
 * advances.
 *
 * `ref` (#2534) is an exact-match filter on the indexed `ref` column; it only
 * narrows the same disclosure_scope-gated result set — it never widens access
 * and there is no payload querying.
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

  // History view (#1790): given any id in a v1<-v2<-... supersession chain,
  // return the whole chain plus any still-pending amendments against its
  // current end — regardless of subject_did, since a chain link's subject
  // never changes across v1/v2/etc.
  const historyOf = searchParams.get('history_of');
  if (historyOf) {
    const history = await resolveAttestationHistory(historyOf);
    if (!history) {
      return NextResponse.json({ error: 'Attestation not found' }, { status: 404, headers: cors });
    }
    return NextResponse.json(history, { headers: cors });
  }

  const subjectDid = searchParams.get('subject_did');
  if (!subjectDid) {
    return NextResponse.json({ error: 'subject_did required' }, { status: 400, headers: cors });
  }

  const typeFilter = searchParams.get('type');
  const issuerFilter = searchParams.get('issuer_did');
  const contextIdFilter = searchParams.get('context_id');
  const refFilter = searchParams.get('ref');
  const cursorResult = resolveCursor(searchParams.get('before'));
  if (!cursorResult.ok) {
    return NextResponse.json({ error: cursorResult.error }, { status: 400, headers: cors });
  }
  const { cursor } = cursorResult;
  const evidenceGradeFilter = searchParams.get('evidence_grade'); // 'unilateral' | 'corroborated' | 'disputed'
  const statusFilter = searchParams.get('status') ?? // 'pending' | 'bilateral' | 'declined'
    (evidenceGradeFilter ? EVIDENCE_GRADE_TO_STATUS[evidenceGradeFilter] : null);
  const limitParam = Number.parseInt(searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(Math.max(1, Number.isNaN(limitParam) ? 20 : limitParam), ATTESTATION_LIMIT_MAX);

  const conditions = buildListConditions({ subjectDid, typeFilter, issuerFilter, statusFilter, contextIdFilter, refFilter, cursor });

  try {
    // Fetch one extra row: its presence is how we know a next page exists.
    const fetched = await db
      .select()
      .from(attestations)
      .where(and(...conditions))
      .orderBy(desc(issuedAtTruncated()), desc(attestations.id))
      .limit(limit + 1);

    const { rows, nextCursor } = splitPage(fetched, limit);
    const responseHeaders = nextCursor
      ? { ...cors, [NEXT_CURSOR_HEADER]: nextCursor, 'Access-Control-Expose-Headers': NEXT_CURSOR_HEADER }
      : cors;

    const visibleRows = await filterVisibleRows(rows, request);

    const annotatedRows = visibleRows.map((row: Attestation) => ({
      ...row,
      evidenceGrade: evidenceGradeForAttestationStatus(row.attestationStatus),
    }));

    return NextResponse.json(annotatedRows, { headers: responseHeaders });
  } catch (error) {
    log.error({ err: String(error) }, 'Attestations GET error');
    return NextResponse.json({ error: 'Failed to query attestations' }, { status: 500, headers: cors });
  }
});

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
