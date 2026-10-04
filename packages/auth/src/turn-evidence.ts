/**
 * `agent.turn.evidence` — tool I/O as the committed boundary of an agent turn
 * (#1978, epic #1758 / RFC-31 v2).
 *
 * One attestation per tool call within a turn. Each commits to *what the
 * agent observed* (hashes of a tool call's input and output, plus a
 * timestamp), never the observation itself: the payload is deliberately
 * redaction-safe — hashes, DIDs, short identifiers, and an optional media
 * asset reference. Free text (tool arguments, tool output, URLs, headers,
 * secrets) has no field to ride in, and {@link parseTurnEvidencePayload}
 * rejects any key outside the closed vocabulary below.
 *
 * Keep this module dependency-light and client-safe: the agent side (the
 * OpenClaw Imajin plugin's turn-finalization hook) imports
 * {@link hashToolIo}, {@link buildTurnEvidencePayload} and
 * {@link turnEvidenceSigningMessage} so the bytes it signs are exactly the
 * bytes the kernel verifies. The kernel never reaches into a harness — the
 * agent publishes signed evidence, the kernel stores and verifies it.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalize } from './sign';

export const TURN_EVIDENCE_ATTESTATION_TYPE = 'agent.turn.evidence' as const;

/** `context_type` every evidence attestation carries; `context_id` is the turn event id. */
export const TURN_EVIDENCE_CONTEXT_TYPE = 'agent.turn' as const;

/** Upper bound on evidence rows accepted in one turn-finalization batch. */
export const TURN_EVIDENCE_MAX_BATCH = 100;

const HASH_PREFIX = 'sha256:';
const HASH_HEX = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ATTESTATION_ID = /^att_[A-Za-z0-9]{1,64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_DID_LENGTH = 256;
const MAX_SEQ = 9999;

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'type',
  'turnEventId',
  'turnOutputHash',
  'agentDid',
  'principalDid',
  'tool',
  'inputHash',
  'outputHash',
  'outputRef',
  'usageRef',
  'observedAt',
  'seq',
]);

const ALLOWED_TOOL_KEYS: ReadonlySet<string> = new Set(['name', 'provider']);

export interface TurnEvidenceTool {
  /** Tool name as the harness reports it, e.g. `web_fetch`, `eth_getCode`. */
  name: string;
  /** Harness/provider that executed it, e.g. `openclaw`. */
  provider: string;
}

export interface TurnEvidencePayload {
  type: typeof TURN_EVIDENCE_ATTESTATION_TYPE;
  /** Id of the turn event this evidence supports (the #1970 mention-ledger event). */
  turnEventId: string;
  /**
   * `outputHash` of the turn itself — the *claim* this evidence supports.
   * Carried on every row so a claim can be resolved to its evidence from the
   * hash alone, without the kernel needing to read the turn event first.
   */
  turnOutputHash: string;
  agentDid: string;
  principalDid: string;
  tool: TurnEvidenceTool;
  /** `sha256:<hex>` over the tool call's input — see {@link hashToolIo}. */
  inputHash: string;
  /** `sha256:<hex>` over the tool call's output — see {@link hashToolIo}. */
  outputHash: string;
  /**
   * Optional media asset id of the retained raw output. Only permitted for
   * tools on the kernel's evidentiary allowlist; the asset must be owned by
   * `principalDid` and its content hash must equal `outputHash`.
   */
  outputRef?: string;
  /** Optional id of the turn's `agent.turn.usage` attestation (#1863). */
  usageRef?: string;
  /** ISO 8601 UTC time the tool result was observed. */
  observedAt: string;
  /** Position of this call within the turn (orders evidence). */
  seq: number;
}

export type TurnEvidenceParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** `sha256:<hex>` over raw bytes. */
export function sha256Hash(bytes: Uint8Array): string {
  return `${HASH_PREFIX}${bytesToHex(sha256(bytes))}`;
}

/**
 * Deterministically hash a tool call's input or output.
 *
 *  - `string`     → SHA-256 of its UTF-8 bytes.
 *  - `Uint8Array` → SHA-256 of the bytes.
 *  - anything else (structured values) → SHA-256 of the UTF-8 bytes of its
 *    canonical JSON ({@link canonicalize}: sorted keys), so property order
 *    never changes the hash.
 *
 * When a raw output is retained as a media asset, retain exactly the bytes
 * that were hashed (the string's UTF-8 bytes, or the canonical JSON) so the
 * asset's own content hash equals `outputHash`.
 */
export function hashToolIo(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('hashToolIo: value must not be undefined');
  }
  const encoder = new TextEncoder();
  if (typeof value === 'string') return sha256Hash(encoder.encode(value));
  if (value instanceof Uint8Array) return sha256Hash(value);
  return sha256Hash(encoder.encode(canonicalize(value)));
}

/**
 * Normalize a caller-supplied hash (`sha256:<hex>` or bare 64-char hex,
 * any case) to the canonical `sha256:<lowercase hex>` form. Returns `null`
 * for anything else.
 */
export function normalizeHash(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lowered = raw.toLowerCase();
  const hex = lowered.startsWith(HASH_PREFIX) ? lowered.slice(HASH_PREFIX.length) : lowered;
  return HASH_HEX.test(hex) ? `${HASH_PREFIX}${hex}` : null;
}

/** Fields accepted by {@link buildTurnEvidencePayload}. */
export type TurnEvidenceFields = Omit<TurnEvidencePayload, 'type'>;

/**
 * Build the canonical evidence payload. Optional keys that are absent are
 * omitted entirely (never `undefined`/`null`), because
 * `canonicalize(undefined)` is not a stable wire form.
 */
export function buildTurnEvidencePayload(fields: TurnEvidenceFields): TurnEvidencePayload {
  const payload: TurnEvidencePayload = {
    type: TURN_EVIDENCE_ATTESTATION_TYPE,
    turnEventId: fields.turnEventId,
    turnOutputHash: fields.turnOutputHash,
    agentDid: fields.agentDid,
    principalDid: fields.principalDid,
    tool: { name: fields.tool.name, provider: fields.tool.provider },
    inputHash: fields.inputHash,
    outputHash: fields.outputHash,
    observedAt: fields.observedAt,
    seq: fields.seq,
  };
  if (fields.outputRef) payload.outputRef = fields.outputRef;
  if (fields.usageRef) payload.usageRef = fields.usageRef;
  return payload;
}

/**
 * The exact object an agent signs for one evidence attestation — the same
 * canonical form `POST /auth/api/attestations` verifies, so a stored
 * evidence row is checkable by anything that can check any attestation
 * (retrace, `GET /auth/api/verify/turn/:hash`).
 */
export function turnEvidenceSigningFields(payload: TurnEvidencePayload, issuedAtMs: number) {
  return {
    subject_did: payload.agentDid,
    type: TURN_EVIDENCE_ATTESTATION_TYPE,
    context_id: payload.turnEventId,
    context_type: TURN_EVIDENCE_CONTEXT_TYPE,
    payload,
    issued_at: issuedAtMs,
  };
}

/** Canonical string an agent signs (Ed25519) for one evidence attestation. */
export function turnEvidenceSigningMessage(payload: TurnEvidencePayload, issuedAtMs: number): string {
  return canonicalize(turnEvidenceSigningFields(payload, issuedAtMs));
}

function isDid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('did:') &&
    value.length > 4 &&
    value.length <= MAX_DID_LENGTH &&
    !/\s/.test(value)
  );
}

function isMatch(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First key of `record` outside `allowed`, if any. Names the key, never its value. */
function findUnexpectedKey(record: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(record).find((key) => !allowed.has(key));
}

function parseTool(raw: unknown): TurnEvidenceParseResult<TurnEvidenceTool> {
  if (!isRecord(raw)) return { ok: false, error: 'payload.tool must be an object' };
  const unexpected = findUnexpectedKey(raw, ALLOWED_TOOL_KEYS);
  if (unexpected !== undefined) {
    return { ok: false, error: `payload.tool.${unexpected} is not a recognized field (name|provider)` };
  }
  if (!isMatch(raw.name, TOOL_TOKEN)) {
    return { ok: false, error: 'payload.tool.name must be a short identifier (letters, digits, _ . : -)' };
  }
  if (!isMatch(raw.provider, TOOL_TOKEN)) {
    return { ok: false, error: 'payload.tool.provider must be a short identifier (letters, digits, _ . : -)' };
  }
  return { ok: true, value: { name: raw.name, provider: raw.provider } };
}

function parseHashField(raw: Record<string, unknown>, key: string): TurnEvidenceParseResult<string> {
  const normalized = normalizeHash(raw[key]);
  // Only the canonical prefixed form is accepted on the wire: the signed
  // bytes must be exactly what is stored.
  if (normalized === null || raw[key] !== normalized) {
    return { ok: false, error: `payload.${key} must be "sha256:" followed by 64 lowercase hex characters` };
  }
  return { ok: true, value: normalized };
}

function parseOptionalRef(
  raw: Record<string, unknown>,
  key: 'outputRef' | 'usageRef',
  pattern: RegExp,
): TurnEvidenceParseResult<string | undefined> {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (!isMatch(value, pattern)) return { ok: false, error: `payload.${key} must be a plain identifier` };
  return { ok: true, value };
}

function parseObservedAt(raw: unknown): TurnEvidenceParseResult<string> {
  if (!isMatch(raw, ISO_UTC) || Number.isNaN(Date.parse(raw))) {
    return { ok: false, error: 'payload.observedAt must be an ISO 8601 UTC timestamp (e.g. 2026-09-04T03:54:12Z)' };
  }
  return { ok: true, value: raw };
}

function parseSeq(raw: unknown): TurnEvidenceParseResult<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_SEQ) {
    return { ok: false, error: `payload.seq must be an integer between 0 and ${MAX_SEQ}` };
  }
  return { ok: true, value: raw };
}

/** Validates the four identity fields (turn id, claim hash, agent DID, principal DID). */
function parseIdentityFields(
  raw: Record<string, unknown>,
): TurnEvidenceParseResult<Pick<TurnEvidencePayload, 'turnEventId' | 'turnOutputHash' | 'agentDid' | 'principalDid'>> {
  if (!isMatch(raw.turnEventId, IDENTIFIER)) {
    return { ok: false, error: 'payload.turnEventId must be a plain identifier' };
  }
  const turnOutputHash = parseHashField(raw, 'turnOutputHash');
  if (!turnOutputHash.ok) return turnOutputHash;
  if (!isDid(raw.agentDid)) return { ok: false, error: 'payload.agentDid must be a DID string' };
  if (!isDid(raw.principalDid)) return { ok: false, error: 'payload.principalDid must be a DID string' };
  return {
    ok: true,
    value: {
      turnEventId: raw.turnEventId,
      turnOutputHash: turnOutputHash.value,
      agentDid: raw.agentDid,
      principalDid: raw.principalDid,
    },
  };
}

/**
 * Strictly validate an `agent.turn.evidence` payload. Purely structural and
 * synchronous; rejects unknown keys so nothing outside the redaction-safe
 * vocabulary (raw tool args/output, secrets, URLs) can be persisted into a
 * signed, publicly-verifiable record. Error messages name the offending
 * *field*, never echo its value.
 */
export function parseTurnEvidencePayload(raw: unknown): TurnEvidenceParseResult<TurnEvidencePayload> {
  if (!isRecord(raw)) return { ok: false, error: 'payload must be an object' };

  const unexpected = findUnexpectedKey(raw, ALLOWED_KEYS);
  if (unexpected !== undefined) {
    return { ok: false, error: `payload.${unexpected} is not a recognized evidence field` };
  }
  if (raw.type !== TURN_EVIDENCE_ATTESTATION_TYPE) {
    return { ok: false, error: `payload.type must be "${TURN_EVIDENCE_ATTESTATION_TYPE}"` };
  }

  const identity = parseIdentityFields(raw);
  if (!identity.ok) return identity;
  const tool = parseTool(raw.tool);
  if (!tool.ok) return tool;
  const inputHash = parseHashField(raw, 'inputHash');
  if (!inputHash.ok) return inputHash;
  const outputHash = parseHashField(raw, 'outputHash');
  if (!outputHash.ok) return outputHash;
  const outputRef = parseOptionalRef(raw, 'outputRef', ASSET_ID);
  if (!outputRef.ok) return outputRef;
  const usageRef = parseOptionalRef(raw, 'usageRef', ATTESTATION_ID);
  if (!usageRef.ok) return usageRef;
  const observedAt = parseObservedAt(raw.observedAt);
  if (!observedAt.ok) return observedAt;
  const seq = parseSeq(raw.seq);
  if (!seq.ok) return seq;

  return {
    ok: true,
    value: buildTurnEvidencePayload({
      ...identity.value,
      tool: tool.value,
      inputHash: inputHash.value,
      outputHash: outputHash.value,
      outputRef: outputRef.value,
      usageRef: usageRef.value,
      observedAt: observedAt.value,
      seq: seq.value,
    }),
  };
}
