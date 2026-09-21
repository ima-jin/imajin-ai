import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { ackGrant, type AckOutcome, type AckEvidence, type GrantAckOutcome } from '@/src/lib/vault';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

const ACK_OUTCOMES: ReadonlySet<string> = new Set(['used', 'failed', 'discarded']);
const MAX_NOTE_LENGTH = 280;
const MAX_EVIDENCE_KIND_LENGTH = 100;
const MAX_EVIDENCE_REF_LENGTH = 120;

interface AckRequestBody {
  outcome?: unknown;
  note?: unknown;
  evidence?: unknown;
}

/** HTTP status for every non-'ok' outcome `ackGrant` can return. */
function statusForOutcome(status: Exclude<GrantAckOutcome['status'], 'ok'>): number {
  switch (status) {
    case 'not_found':
    case 'not_grantee':
      // Identical response shape for both, same anti-enumeration posture as
      // POST .../fetch: confirming a grantId exists but belongs to someone
      // else would let a caller enumerate grantIds it cannot use.
      return 404;
    case 'not_fetched':
    case 'conflict':
    default:
      return 409;
  }
}

/** Machine-readable error code for every non-'ok' outcome `ackGrant` can return. */
function errorForOutcome(status: Exclude<GrantAckOutcome['status'], 'ok'>): string {
  switch (status) {
    case 'not_found':
    case 'not_grantee':
      return 'No delegation grant found for this id';
    case 'not_fetched':
      return 'grant_not_fetched';
    case 'conflict':
    default:
      return 'ack_conflict';
  }
}

/**
 * Map `ackGrant`'s internal 'conflict' status to the wire-level 'ack_conflict'
 * code used for both the response `error` field and the audit event's
 * `refused` field — kept as its own function so the two call sites (response
 * body + audit) can never drift.
 */
function refusedCodeForOutcome(
  status: Exclude<GrantAckOutcome['status'], 'ok'>,
): 'not_found' | 'not_grantee' | 'not_fetched' | 'ack_conflict' {
  return status === 'conflict' ? 'ack_conflict' : status;
}

function validateAckOutcome(outcome: unknown): string | null {
  if (typeof outcome !== 'string' || !ACK_OUTCOMES.has(outcome)) {
    return "outcome must be one of 'used', 'failed', 'discarded'";
  }
  return null;
}

function validateAckNote(note: unknown): string | null {
  if (note === undefined || note === null) {
    return null;
  }
  if (typeof note !== 'string' || note.length === 0 || note.length > MAX_NOTE_LENGTH) {
    return `note must be a non-empty string of at most ${MAX_NOTE_LENGTH} characters`;
  }
  return null;
}

function validateAckEvidence(evidence: unknown): string | null {
  if (evidence === undefined || evidence === null) {
    return null;
  }
  if (typeof evidence !== 'object' || Array.isArray(evidence)) {
    return 'evidence must be an object with kind and ref';
  }
  const { kind, ref } = evidence as Record<string, unknown>;
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > MAX_EVIDENCE_KIND_LENGTH) {
    return `evidence.kind must be a non-empty string of at most ${MAX_EVIDENCE_KIND_LENGTH} characters`;
  }
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_EVIDENCE_REF_LENGTH) {
    return `evidence.ref must be a non-empty string of at most ${MAX_EVIDENCE_REF_LENGTH} characters`;
  }
  return null;
}

/**
 * Validate the ack request body, returning an error message or null.
 *
 * Split into per-field helpers so this stays under the cognitive-complexity
 * budget — the same pattern #2231's `validateGrantMetadata` established for
 * the grant-issuance route. Every field not named here (i.e. anything beyond
 * outcome/note/evidence) is simply ignored, matching that same precedent.
 */
function validateAckBody(body: AckRequestBody): string | null {
  return (
    validateAckOutcome(body.outcome) ??
    validateAckNote(body.note) ??
    validateAckEvidence(body.evidence)
  );
}

/**
 * Fold the request body's `note` and `evidence` into the single jsonb blob
 * `ackGrant` persists (see the migration 0149 / schema docblocks for why
 * there is no separate `note` column). Returns null when neither was given.
 */
function buildAckEvidence(body: AckRequestBody): AckEvidence | null {
  const note = typeof body.note === 'string' ? body.note : undefined;
  const evidence = body.evidence as { kind: string; ref: string } | undefined;
  if (note === undefined && evidence === undefined) {
    return null;
  }
  return {
    ...(evidence ? { kind: evidence.kind, ref: evidence.ref } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

/** Fire-and-forget audit publish — never fails the ack request itself. */
function auditAck(params: {
  grantId: string;
  granteeDid: string;
  ownerDid: string | null;
  purpose: string | null;
  outcome: AckOutcome;
  evidenceKind: string | null;
  ackedAt: string | null;
  refused: 'not_found' | 'not_grantee' | 'not_fetched' | 'ack_conflict' | 'error' | null;
}): void {
  publish('vault.delegation.acked', {
    issuer: params.granteeDid,
    subject: params.granteeDid,
    scope: 'vault',
    payload: {
      grantId: params.grantId,
      granteeDid: params.granteeDid,
      ownerDid: params.ownerDid,
      purpose: params.purpose,
      outcome: params.outcome,
      evidenceKind: params.evidenceKind,
      ackedAt: params.ackedAt,
      refused: params.refused,
      context_id: params.grantId,
      context_type: 'vault.delegation',
    },
  }).catch((err: unknown) => {
    log.error({ err: String(err), grantId: params.grantId }, 'Bus publish error for vault.delegation.acked');
  });
}

/**
 * POST /api/vault/delegation/grants/{grantId}/ack — an authenticated agent
 * DID signs what it did with the secret behind a delegation grant it already
 * fetched (#2235, follow-up to #2231's fetch route).
 *
 * Session/bearer-authenticated as the agent DID itself (`requireAuth`), NOT
 * `requireAdmin` — identical caller shape to POST .../fetch. The kernel
 * validates, in order: the grant exists, it was granted to THIS caller, and
 * it has actually been fetched before (`grant_not_fetched` otherwise).
 * Acking is idempotent per grant+outcome — repeating the SAME outcome
 * returns 200 with the original `ackedAt`; a DIFFERENT outcome is a 409
 * `ack_conflict`. Every attempt, successful or refused, is audited via the
 * `vault.delegation.acked` bus event (never carries the secret value, the
 * free-text `note`, or `evidence.ref` — only the evidence `kind` label).
 */
export async function POST(request: Request, props: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await props.params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const granteeDid = authResult.identity.id;

  let body: AckRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
  }

  const validationError = validateAckBody(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const outcome = body.outcome as AckOutcome;
  const evidence = buildAckEvidence(body);

  try {
    const result = await ackGrant({ grantId, granteeDid, outcome, evidence });

    if (result.status !== 'ok') {
      auditAck({
        grantId,
        granteeDid,
        ownerDid: null,
        purpose: null,
        outcome,
        evidenceKind: evidence?.kind ?? null,
        ackedAt: result.status === 'conflict' ? result.ackedAt.toISOString() : null,
        refused: refusedCodeForOutcome(result.status),
      });
      return NextResponse.json(
        {
          error: errorForOutcome(result.status),
          ...(result.status === 'conflict'
            ? { ackedAt: result.ackedAt.toISOString(), ackOutcome: result.ackOutcome }
            : {}),
        },
        { status: statusForOutcome(result.status) },
      );
    }

    auditAck({
      grantId,
      granteeDid,
      ownerDid: result.ownerDid,
      purpose: result.purpose,
      outcome: result.ackOutcome,
      evidenceKind: evidence?.kind ?? null,
      ackedAt: result.ackedAt.toISOString(),
      refused: null,
    });

    return NextResponse.json({
      ok: true,
      grantId,
      outcome: result.ackOutcome,
      ackedAt: result.ackedAt.toISOString(),
    });
  } catch (error) {
    auditAck({
      grantId,
      granteeDid,
      ownerDid: null,
      purpose: null,
      outcome,
      evidenceKind: evidence?.kind ?? null,
      ackedAt: null,
      refused: 'error',
    });
    log.error({ err: String(error), grantId, granteeDid }, 'Vault delegation grant ack error');
    return toVaultErrorResponse(error, 'Failed to ack delegation grant', 500);
  }
}
