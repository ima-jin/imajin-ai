/**
 * Wire shape + validation for the turn-finalization evidence batch (#1978).
 *
 * The agent side (the OpenClaw Imajin plugin's turn hook) collects every tool
 * call of a turn, signs each evidence attestation locally with the agent's
 * DID key, and posts them all in ONE request — a hook at turn finalization,
 * not a per-call round trip. Each item is exactly what
 * `POST /auth/api/attestations` would accept for one attestation of this
 * type, so a stored row verifies the same way any attestation does.
 *
 * Purely structural/synchronous here; cryptographic checks and DB lookups
 * live in ./ingest.ts.
 */
import {
  FUTURE_TOLERANCE,
  TURN_EVIDENCE_MAX_BATCH,
  parseTurnEvidencePayload,
  type TurnEvidencePayload,
} from '@imajin/auth';

const ED25519_SIGNATURE_HEX = /^[0-9a-f]{128}$/i;

export interface TurnEvidenceItem {
  payload: TurnEvidencePayload;
  /** Unix epoch ms the agent signed at (part of the signed canonical form). */
  issuedAt: number;
  /** Ed25519 signature, lowercase hex, over `turnEvidenceSigningMessage(payload, issuedAt)`. */
  signature: string;
}

export interface TurnEvidenceBatch {
  turnEventId: string;
  turnOutputHash: string;
  agentDid: string;
  principalDid: string;
  items: TurnEvidenceItem[];
}

export type ParseBatchResult = { ok: true; value: TurnEvidenceBatch } | { ok: false; error: string };

function parseItem(raw: unknown, index: number): { ok: true; value: TurnEvidenceItem } | { ok: false; error: string } {
  const label = `evidence[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${label} must be an object` };
  }
  const { payload, issued_at: issuedAt, signature } = raw as Record<string, unknown>;

  const parsedPayload = parseTurnEvidencePayload(payload);
  if (!parsedPayload.ok) return { ok: false, error: `${label}: ${parsedPayload.error}` };

  if (typeof issuedAt !== 'number' || !Number.isInteger(issuedAt) || issuedAt <= 0) {
    return { ok: false, error: `${label}.issued_at must be a Unix epoch milliseconds integer` };
  }
  if (issuedAt > Date.now() + FUTURE_TOLERANCE) {
    return { ok: false, error: `${label}.issued_at is in the future` };
  }
  if (typeof signature !== 'string' || !ED25519_SIGNATURE_HEX.test(signature)) {
    return { ok: false, error: `${label}.signature must be a 128-char hex Ed25519 signature` };
  }

  return { ok: true, value: { payload: parsedPayload.value, issuedAt, signature: signature.toLowerCase() } };
}

/** First reason the items disagree about the turn they belong to, or `null` when consistent. */
function findBatchInconsistency(items: readonly TurnEvidenceItem[]): string | null {
  const [first] = items;
  const seenSeq = new Set<number>();
  for (const [index, { payload }] of items.entries()) {
    const sameTurn =
      payload.turnEventId === first.payload.turnEventId &&
      payload.turnOutputHash === first.payload.turnOutputHash &&
      payload.agentDid === first.payload.agentDid &&
      payload.principalDid === first.payload.principalDid;
    if (!sameTurn) {
      return `evidence[${index}] names a different turn, turn output hash, agent or principal than evidence[0]`;
    }
    if (seenSeq.has(payload.seq)) return `evidence[${index}].seq duplicates another item in the batch`;
    seenSeq.add(payload.seq);
  }
  return null;
}

/**
 * Shape-validate a `POST /auth/api/attestations/turn-evidence` body:
 * `{ evidence: [{ payload, issued_at, signature }, ...] }`. Every item must
 * belong to the same turn/agent/principal, with distinct `seq`s.
 */
export function parseTurnEvidenceBatch(raw: unknown): ParseBatchResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'request body must be an object' };
  }
  const { evidence } = raw as Record<string, unknown>;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, error: 'evidence must be a non-empty array' };
  }
  if (evidence.length > TURN_EVIDENCE_MAX_BATCH) {
    return { ok: false, error: `evidence may hold at most ${TURN_EVIDENCE_MAX_BATCH} items per batch` };
  }

  const items: TurnEvidenceItem[] = [];
  for (const [index, entry] of evidence.entries()) {
    const parsed = parseItem(entry, index);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }

  const inconsistency = findBatchInconsistency(items);
  if (inconsistency) return { ok: false, error: inconsistency };

  const { turnEventId, turnOutputHash, agentDid, principalDid } = items[0].payload;
  return { ok: true, value: { turnEventId, turnOutputHash, agentDid, principalDid, items } };
}
