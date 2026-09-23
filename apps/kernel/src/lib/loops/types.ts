/**
 * Kernel loop registry (#2295, epic #2288/#2290) — shared types + wire-shape
 * validation for the `loop.*` ingest envelope.
 *
 * `LoopEnvelope` is the common envelope every `loop.started|progress|
 * blocked|finished` bus event carries (see #2290's "Shape" section):
 * `{ loopId, kind, principal, parentLoopId?, refs?, state, summary, at }`.
 * `LoopPublisherSignature` mirrors the operator-countersignature wire shape
 * (`apps/kernel/src/lib/notify/operator-countersign.ts`) — a hex Ed25519
 * public key (`keyId`), fixed `alg`, and a hex signature.
 */
import { SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from '@imajin/auth';

export const LOOP_LIFECYCLE_TYPES = ['loop.started', 'loop.progress', 'loop.blocked', 'loop.finished'] as const;
export type LoopLifecycleType = (typeof LOOP_LIFECYCLE_TYPES)[number];

export function isLoopLifecycleType(value: unknown): value is LoopLifecycleType {
  return typeof value === 'string' && (LOOP_LIFECYCLE_TYPES as readonly string[]).includes(value);
}

export interface LoopRefs {
  issue?: string;
  pr?: string;
  runId?: string;
  sessionKey?: string;
}

export interface LoopEnvelope {
  loopId: string;
  kind: string;
  principal: string;
  parentLoopId?: string | null;
  refs?: LoopRefs;
  state: string;
  summary: string;
  at: string;
  /** Index signature so this stays assignable to @imajin/bus's `LoopEventPayload` (`BusEventMap[T]`) when publishing. */
  [key: string]: unknown;
}

export interface LoopPublisherSignature {
  keyId: string;
  alg: 'ed25519';
  sig: string;
}

export interface LoopIngestRequest {
  type: LoopLifecycleType;
  payload: LoopEnvelope;
  publisherDid: string;
  signature: LoopPublisherSignature;
}

const ED25519_PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/i;
const ED25519_SIGNATURE_HEX = /^[0-9a-f]{128}$/i;
const MAX_SUMMARY_LENGTH = 2000;
const REFS_KEYS = new Set(['issue', 'pr', 'runId', 'sessionKey']);

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isDid(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('did:') && value.length > 4;
}

function parseRefs(raw: unknown): ParseResult<LoopRefs | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'payload.refs must be an object' };
  }
  const refs: LoopRefs = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!REFS_KEYS.has(key)) {
      return { ok: false, error: `payload.refs.${key} is not a recognized ref (issue|pr|runId|sessionKey)` };
    }
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, error: `payload.refs.${key} must be a non-empty string` };
    }
    (refs as Record<string, string>)[key] = value;
  }
  return { ok: true, value: refs };
}

/** Bounds-check `at` the same way `verify.ts` bounds a signed message's timestamp. */
export function isWithinClockSkew(at: string): boolean {
  const claimed = Date.parse(at);
  if (Number.isNaN(claimed)) return false;
  const age = Date.now() - claimed;
  return age <= SIGNED_MESSAGE_MAX_AGE && age >= -FUTURE_TOLERANCE;
}

function parseEnvelope(raw: unknown): ParseResult<LoopEnvelope> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'payload must be an object' };
  }
  const { loopId, kind, principal, parentLoopId, refs, state, summary, at } = raw as Record<string, unknown>;

  if (typeof loopId !== 'string' || loopId.length === 0) {
    return { ok: false, error: 'payload.loopId must be a non-empty string' };
  }
  if (typeof kind !== 'string' || kind.length === 0) {
    return { ok: false, error: 'payload.kind must be a non-empty string' };
  }
  if (!isDid(principal)) {
    return { ok: false, error: 'payload.principal must be a DID string' };
  }
  if (parentLoopId !== undefined && parentLoopId !== null && (typeof parentLoopId !== 'string' || parentLoopId.length === 0)) {
    return { ok: false, error: 'payload.parentLoopId must be a non-empty string when present' };
  }
  if (typeof state !== 'string' || state.length === 0) {
    return { ok: false, error: 'payload.state must be a non-empty string' };
  }
  if (typeof summary !== 'string' || summary.length === 0 || summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, error: `payload.summary must be a non-empty string of at most ${MAX_SUMMARY_LENGTH} characters` };
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    return { ok: false, error: 'payload.at must be an ISO 8601 timestamp' };
  }
  if (!isWithinClockSkew(at)) {
    return { ok: false, error: 'payload.at is outside the accepted clock-skew window' };
  }

  const refsResult = parseRefs(refs);
  if (!refsResult.ok) return refsResult;

  return {
    ok: true,
    value: {
      loopId,
      kind,
      principal,
      parentLoopId: (parentLoopId as string | null | undefined) ?? null,
      refs: refsResult.value,
      state,
      summary,
      at,
    },
  };
}

function parseSignature(raw: unknown): ParseResult<LoopPublisherSignature> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'signature must be an object' };
  }
  const { keyId, alg, sig } = raw as Record<string, unknown>;
  if (typeof keyId !== 'string' || !ED25519_PUBLIC_KEY_HEX.test(keyId)) {
    return { ok: false, error: 'signature.keyId must be a 64-char hex Ed25519 public key' };
  }
  if (alg !== 'ed25519') {
    return { ok: false, error: "signature.alg must be 'ed25519'" };
  }
  if (typeof sig !== 'string' || !ED25519_SIGNATURE_HEX.test(sig)) {
    return { ok: false, error: 'signature.sig must be a 128-char hex Ed25519 signature' };
  }
  return { ok: true, value: { keyId: keyId.toLowerCase(), alg, sig: sig.toLowerCase() } };
}

/**
 * Shape-validate a `POST /api/loops` ingest request body. Purely
 * structural — cryptographic verification is
 * {@link verifyLoopPublisherSignature}, which requires a DB lookup and so
 * stays async and separate from this synchronous parse step (same split as
 * `parseOperatorSignature`/`verifyOperatorCountersignature`).
 */
export function parseLoopIngestRequest(raw: unknown): ParseResult<LoopIngestRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'request body must be an object' };
  }
  const { type, payload, publisherDid, signature } = raw as Record<string, unknown>;

  if (!isLoopLifecycleType(type)) {
    return { ok: false, error: `type must be one of ${LOOP_LIFECYCLE_TYPES.join(', ')}` };
  }
  if (!isDid(publisherDid)) {
    return { ok: false, error: 'publisherDid must be a DID string' };
  }

  const envelopeResult = parseEnvelope(payload);
  if (!envelopeResult.ok) return envelopeResult;

  const signatureResult = parseSignature(signature);
  if (!signatureResult.ok) return signatureResult;

  return {
    ok: true,
    value: { type, payload: envelopeResult.value, publisherDid, signature: signatureResult.value },
  };
}
