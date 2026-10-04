/**
 * Outsider-checkable verification of a turn claim (#1978).
 *
 * Backs `GET /auth/api/verify/turn/:hash` — no auth. Given the turn's
 * `outputHash` (the claim), it returns the evidence chain committed under it:
 * every `agent.turn.evidence` row's tool name, hashes and timestamps, the
 * signer, and whether each row's signature still verifies against the
 * signer's registered key. Modeled on trustless-ai's free, no-auth,
 * recompute-able `/verify-proof`: an agent outside the room can recompute
 * the hash of the text it was shown, look it up here, and need no account.
 *
 * Signatures are re-verified from the *stored* row (subject, type, context,
 * payload, issued_at) — exactly the canonical form the agent signed — so
 * altering any stored byte of a row flips `signatureValid` to false rather
 * than silently passing.
 *
 * What is deliberately NOT returned (public endpoint, redaction-safe):
 * `principalDid`, `outputRef`/`usageRef` values, and any turn-event payload.
 * `retained` only says whether raw output is retained.
 *
 * I/O is behind {@link VerifyDeps}; `./verify-deps.ts` supplies production
 * implementations.
 */
import { canonicalize, crypto as authCrypto, normalizeHash, parseTurnEvidencePayload } from '@imajin/auth';
import type { TurnEvidenceTool } from '@imajin/auth';

export interface StoredEvidenceRow {
  id: string;
  issuerDid: string;
  subjectDid: string;
  type: string;
  contextId: string | null;
  contextType: string | null;
  payload: unknown;
  signature: string;
  issuedAt: Date;
}

/** Minimal view of the #1970 turn event, as resolved from the bus event log. */
export interface TurnEventRef {
  id: string;
  eventType: string;
  issuer: string;
  occurredAt: Date;
  /** The turn's own `outputHash` as the turn event recorded it, if present. */
  outputHash: string | null;
  /** The turn event's link to its `agent.turn.usage` attestation, if present. */
  usageRef: string | null;
}

export interface VerifyDeps {
  findEvidenceByTurnOutputHash(hash: string): Promise<StoredEvidenceRow[]>;
  resolveIssuerKey(did: string): Promise<string | null>;
  resolveTurnEvent(turnEventId: string): Promise<TurnEventRef | null>;
  /** Is `id` a live `agent.turn.usage` attestation whose subject is `agentDid`? */
  usageExists(id: string, agentDid: string): Promise<boolean>;
}

export interface VerifiedEvidence {
  attestationId: string;
  seq: number;
  tool: TurnEvidenceTool;
  inputHash: string;
  outputHash: string;
  observedAt: string;
  issuedAt: string;
  /** True when the raw output is retained as a media asset (reference itself is not disclosed). */
  retained: boolean;
  signatureValid: boolean;
}

export type TurnLinkage = 'resolved' | 'unresolved' | 'mismatch';
export type UsageLinkage = 'resolved' | 'unresolved' | 'none';

export interface TurnMatch {
  turnEventId: string;
  agentDid: string;
  signer: { did: string; keyId: string | null };
  turn: { id: string; eventType: string; issuer: string; occurredAt: string } | null;
  linkage: { turn: TurnLinkage; usage: UsageLinkage };
  /** True iff every evidence row's signature verifies. */
  signatureValid: boolean;
  /** Rows that matched the hash but could not be interpreted as valid evidence (never silently dropped). */
  rejectedRows: number;
  /** signatureValid, no rejected rows, and the turn event (if resolvable) agrees on the hash. */
  valid: boolean;
  evidence: VerifiedEvidence[];
}

export type VerifyTurnResult = { found: false } | { found: true; hash: string; matches: TurnMatch[] };

interface RowCheck {
  valid: boolean;
  evidence: VerifiedEvidence | null;
}

function checkRow(row: StoredEvidenceRow, hash: string, publicKey: string | null): RowCheck {
  const parsed = parseTurnEvidencePayload(row.payload);
  const consistent =
    parsed.ok &&
    parsed.value.agentDid === row.issuerDid &&
    parsed.value.turnEventId === row.contextId &&
    parsed.value.turnOutputHash === hash;
  if (!parsed.ok || !consistent) return { valid: false, evidence: null };

  const canonical = canonicalize({
    subject_did: row.subjectDid,
    type: row.type,
    context_id: row.contextId ?? null,
    context_type: row.contextType ?? null,
    payload: row.payload ?? null,
    issued_at: new Date(row.issuedAt).getTime(),
  });
  const signatureValid = publicKey !== null && authCrypto.verifySync(row.signature, canonical, publicKey.toLowerCase());

  const { value } = parsed;
  return {
    valid: signatureValid,
    evidence: {
      attestationId: row.id,
      seq: value.seq,
      tool: value.tool,
      inputHash: value.inputHash,
      outputHash: value.outputHash,
      observedAt: value.observedAt,
      issuedAt: new Date(row.issuedAt).toISOString(),
      retained: value.outputRef !== undefined,
      signatureValid,
    },
  };
}

function groupByTurnAndIssuer(rows: readonly StoredEvidenceRow[]): Map<string, StoredEvidenceRow[]> {
  const groups = new Map<string, StoredEvidenceRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.contextId, row.issuerDid]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function turnLinkage(turn: TurnEventRef | null, hash: string): TurnLinkage {
  const turnHash = turn?.outputHash ?? null;
  if (turnHash === null) return 'unresolved';
  return normalizeHash(turnHash) === hash ? 'resolved' : 'mismatch';
}

async function usageLinkage(
  turn: TurnEventRef | null,
  evidence: readonly VerifiedEvidence[],
  rows: readonly StoredEvidenceRow[],
  agentDid: string,
  deps: VerifyDeps,
): Promise<UsageLinkage> {
  const fromEvidence = rows
    .map((row) => (row.payload as { usageRef?: unknown } | null)?.usageRef)
    .find((ref): ref is string => typeof ref === 'string');
  const usageRef = turn?.usageRef ?? fromEvidence;
  if (!usageRef || evidence.length === 0) return 'none';
  return (await deps.usageExists(usageRef, agentDid)) ? 'resolved' : 'unresolved';
}

async function buildMatch(
  rows: readonly StoredEvidenceRow[],
  hash: string,
  deps: VerifyDeps,
  keyCache: Map<string, Promise<string | null>>,
): Promise<TurnMatch> {
  const { issuerDid, contextId } = rows[0];
  const turnEventId = contextId ?? '';

  let keyLookup = keyCache.get(issuerDid);
  if (!keyLookup) {
    keyLookup = deps.resolveIssuerKey(issuerDid);
    keyCache.set(issuerDid, keyLookup);
  }
  const [publicKey, turn] = await Promise.all([keyLookup, deps.resolveTurnEvent(turnEventId)]);

  const checks = rows.map((row) => checkRow(row, hash, publicKey));
  const evidence = checks
    .flatMap((check) => (check.evidence ? [check.evidence] : []))
    .sort((a, b) => a.seq - b.seq);
  const rejectedRows = checks.filter((check) => check.evidence === null).length;
  const signatureValid = checks.every((check) => check.valid);

  const turnLink = turnLinkage(turn, hash);
  const usageLink = await usageLinkage(turn, evidence, rows, issuerDid, deps);

  return {
    turnEventId,
    agentDid: issuerDid,
    signer: { did: issuerDid, keyId: publicKey ? publicKey.toLowerCase() : null },
    turn: turn
      ? { id: turn.id, eventType: turn.eventType, issuer: turn.issuer, occurredAt: turn.occurredAt.toISOString() }
      : null,
    linkage: { turn: turnLink, usage: usageLink },
    signatureValid,
    rejectedRows,
    valid: signatureValid && rejectedRows === 0 && turnLink !== 'mismatch',
    evidence,
  };
}

/**
 * Resolve a claim hash to its signed evidence chain. `{ found: false }` for a
 * hash no evidence is committed under (the route maps it to 404) — including
 * the case where the claim's text was altered by even one byte, since its
 * hash then matches nothing.
 */
export async function verifyTurnByHash(rawHash: string, deps: VerifyDeps): Promise<VerifyTurnResult> {
  const hash = normalizeHash(rawHash);
  if (hash === null) return { found: false };

  const rows = await deps.findEvidenceByTurnOutputHash(hash);
  if (rows.length === 0) return { found: false };

  const keyCache = new Map<string, Promise<string | null>>();
  const matches = await Promise.all(
    [...groupByTurnAndIssuer(rows).values()].map((group) => buildMatch(group, hash, deps, keyCache)),
  );
  matches.sort((a, b) => a.turnEventId.localeCompare(b.turnEventId) || a.agentDid.localeCompare(b.agentDid));

  return { found: true, hash, matches };
}
