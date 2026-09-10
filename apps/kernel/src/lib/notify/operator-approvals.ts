/**
 * Operator approvals — contract types and payload validation (#2059,
 * generalized to an open source/kind vocabulary by #2152).
 *
 * Kernel half of "operator approvals appear as a signed confirm on /jin —
 * approve from anywhere". #2059 shipped a single hard-coded vocabulary
 * (OpenClaw system-agent proposals: `kind: restart | config-mutation |
 * other`). #2152 generalizes it so ANY source can raise a proposal —
 * `source` names the raiser (e.g. `system-agent`, `skill-workshop`) and
 * `kind` is namespaced `"<source>:<subkind>"` (e.g. `system-agent:restart`,
 * `skill-workshop:update`). Legacy bare kinds (no `source` field) still
 * ingest exactly as before and normalize onto `system-agent:*`, so an
 * unmigrated plugin release never breaks (#2152 requirement: sources don't
 * have to be lock-stepped).
 *
 * Two kernel notification kinds make up the contract with external
 * publishers (the OpenClaw plugin's bridge, ima-jin/openclaw-imajin-
 * plugin#33 — a separate repo/process; this module defines what it
 * implements against, never imports it):
 *
 *   operator.approval.requested — a source adapter publishes this via
 *     `POST /notify/api/send` (the same webhook-secret-gated ingestion
 *     every other notify scope uses) when it stages a proposal. Renders as
 *     a confirm card on /jin, keyed by `source` for per-source rendering.
 *     NEVER carries secret values — only key PATHS the proposal touches
 *     (see {@link validateApprovalRequestedPayload}). May carry an
 *     optional, bounded `detail` object (≤16KB) with per-source structured
 *     fields (e.g. skill-workshop's diff summary); `contentHash` is a
 *     sha256 digest covering the whole canonical payload INCLUDING `detail`
 *     — kernel independently recomputes and rejects a mismatch, so what
 *     the operator sees on /jin is provably what a source later applies.
 *
 *   operator.approval.decided — the kernel publishes this via `bus.publish`
 *     once the operator taps Approve/Reject (or withdraws) on /jin,
 *     carrying `source` + `kind` through unchanged so the receiving
 *     adapter can route the decision. Delivered to any subscriber over the
 *     #1884 grant-bound event-subscription fan-out (packages/bus/src/
 *     subscriptions.ts) — a subscriber's agent DID needs an active grant
 *     for the `operator:approvals` capability (packages/auth/src/grant-
 *     scopes.ts) to receive it live; it can always catch up via
 *     `kernel.event_subscription_log` otherwise. Attestation-shaped: who
 *     decided, what proposal, when, and why (optional). The kernel never
 *     interprets `decision` beyond witnessing it — any source-specific
 *     mapping (e.g. system-agent's approve → `allow-once`) happens in the
 *     adapter, optionally recorded here as an opaque `mode`.
 *
 * See docs/notify-operator-approvals-contract.md for the full contract
 * doc aimed at source implementers.
 */
import { createHash } from 'node:crypto';
import type { Identity } from '@imajin/auth';
import { canonicalize } from '@imajin/auth';
import { getNodeSelfInfo } from '@/src/lib/kernel/node-identity';

export const OPERATOR_APPROVAL_REQUESTED_SCOPE = 'operator.approval.requested';

/** The source namespace legacy bare kinds normalize onto (#2152). */
export const SYSTEM_AGENT_SOURCE = 'system-agent';

/** Bare kinds accepted from a plugin release that predates #2152's open vocabulary. */
const LEGACY_BARE_KINDS = new Set(['restart', 'config-mutation', 'other']);

export type ApprovalRequestAction = 'approve' | 'reject';
export type ApprovalDecision = 'approve' | 'reject' | 'withdrawn';

/** The `operator.approval.requested` notification payload (the /jin card). */
export interface OperatorApprovalRequestedPayload {
  proposalId: string;
  /** Open vocabulary namespace, e.g. 'system-agent', 'skill-workshop' (#2152). */
  source: string;
  /** Namespaced `"<source>:<subkind>"`, e.g. 'system-agent:restart' (#2152). */
  kind: string;
  summary: string;
  /** Key paths the proposal touches — paths only, never resolved values. */
  keysTouched: string[];
  /** Optional, bounded (≤16KB) per-source structured detail (#2152). */
  detail: Record<string, unknown> | null;
  /** sha256 hex digest over the canonical payload including `detail` (#2152). */
  contentHash: string;
  actions: readonly ApprovalRequestAction[];
}

/** The signed `operator.approval.decided` event payload. */
export interface OperatorApprovalDecidedPayload {
  proposalId: string;
  source: string;
  kind: string;
  decision: ApprovalDecision;
  /** Opaque, source-adapter-chosen refinement of `decision` (e.g. 'allow-once') — kernel never interprets it (#2152). */
  mode?: string;
  decidedBy: string;
  decidedAt: string;
  reason?: string;
}

export const REQUEST_ACTIONS: readonly ApprovalRequestAction[] = ['approve', 'reject'] as const;

/** Lowercase, hyphenated identifier — used for both `source` and each kind's subkind segment. */
const NAMESPACE_SEGMENT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** A key path is a short, plain identifier chain — never a resolved value. */
const KEY_PATH_PATTERN = /^\w[\w.\-/]{0,199}$/;
const MAX_KEYS_TOUCHED = 50;
const MAX_SUMMARY_LENGTH = 2000;
/** #2152 hard requirement: detail is bounded to 16KB. */
const MAX_DETAIL_BYTES = 16 * 1024;
/** sha256 hex digest, optionally prefixed 'sha256:' the way media's manifestDigest is written. */
const HEX64_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Heuristic secret-value detector for the notify boundary (#2059 acceptance
 * (e)). There is no shared `SecretRef` type available in this repo (that
 * lives in the plugin's own config model), so this is a defense-in-depth
 * pattern match on the shapes a resolved secret actually takes — PEM
 * blocks, common vendor token prefixes, long hex/base64 blobs, and bearer
 * headers — rather than a parse of a specific schema. A false positive here
 * only means a legitimate key path gets rejected with a clear 400; a false
 * negative would leak a secret into a notification, so the patterns below
 * are intentionally broad.
 */
export function looksLikeSecretValue(value: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  // Case-insensitive (`i`) flags below, so each character class lists only
  // the lowercase half of any letter range — listing both cases under `i`
  // is a duplicate-character-class smell (S5869) with no behavior change.
  if (/^(sk|pk|ghp|gho|ghu|ghs|xox[baprs])[-_][a-z0-9_-]{10,}$/i.test(value)) return true;
  if (/^[a-f0-9]{32,}$/i.test(value)) return true;
  if (/^[a-z0-9+/]{40,}={0,2}$/i.test(value)) return true;
  if (/bearer\s+\S+/i.test(value)) return true;
  return false;
}

function isValidKeyPath(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATH_PATTERN.test(value) && !looksLikeSecretValue(value);
}

export interface PayloadValidationResult {
  ok: boolean;
  error?: string;
  /** Normalized open-vocabulary source, present when `ok`. */
  source?: string;
  /** Normalized namespaced kind (`"<source>:<subkind>"`), present when `ok`. */
  kind?: string;
  /** Bounds-checked detail, present (possibly null) when `ok`. */
  detail?: Record<string, unknown> | null;
  /** Verified contentHash, present (possibly null for a legacy bare-kind request) when `ok`. */
  contentHash?: string | null;
}

type NormalizeResult = { ok: true; source: string; kind: string } | { ok: false; error: string };

/**
 * Normalize `{source?, kind}` into `{source, kind}` (#2152).
 *
 * Two accepted shapes:
 *   - Legacy bare kind, no `source` field at all — must be one of the
 *     original three literals; normalizes onto `system-agent:<kind>` so an
 *     unmigrated plugin release keeps working unchanged.
 *   - Open vocabulary: `source` is a lowercase-hyphenated identifier and
 *     `kind` must be namespaced `"<source>:<subkind>"` with a
 *     lowercase-hyphenated subkind — the redundant prefix is required
 *     (rather than derived) so a caller cannot send a `kind` that silently
 *     disagrees with its own `source`.
 */
function normalizeSourceAndKind(data: Record<string, unknown>): NormalizeResult {
  const { source, kind } = data;

  if (source === undefined) {
    if (typeof kind !== 'string' || !LEGACY_BARE_KINDS.has(kind)) {
      return { ok: false, error: "kind must be one of 'restart' | 'config-mutation' | 'other' when source is omitted" };
    }
    return { ok: true, source: SYSTEM_AGENT_SOURCE, kind: `${SYSTEM_AGENT_SOURCE}:${kind}` };
  }

  if (typeof source !== 'string' || !NAMESPACE_SEGMENT_PATTERN.test(source)) {
    return { ok: false, error: 'source must be a lowercase, hyphenated identifier' };
  }
  if (typeof kind !== 'string') {
    return { ok: false, error: 'kind is required' };
  }
  const prefix = `${source}:`;
  if (!kind.startsWith(prefix)) {
    return { ok: false, error: `kind must be namespaced as '${prefix}<subkind>'` };
  }
  if (!NAMESPACE_SEGMENT_PATTERN.test(kind.slice(prefix.length))) {
    return { ok: false, error: 'kind subkind must be a lowercase, hyphenated identifier' };
  }
  return { ok: true, source, kind };
}

type DetailResult = { ok: true; detail: Record<string, unknown> | null } | { ok: false; error: string };

/** Bounds-check the optional per-source `detail` object (#2152 hard requirement: ≤16KB). */
function validateDetail(detail: unknown): DetailResult {
  if (detail === undefined || detail === null) return { ok: true, detail: null };
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    return { ok: false, error: 'detail must be a JSON object' };
  }
  const size = Buffer.byteLength(JSON.stringify(detail), 'utf-8');
  if (size > MAX_DETAIL_BYTES) {
    return { ok: false, error: `detail must be at most ${MAX_DETAIL_BYTES} bytes` };
  }
  return { ok: true, detail: detail as Record<string, unknown> };
}

interface ContentHashFields {
  proposalId: string;
  source: string;
  kind: string;
  summary: string;
  keysTouched: string[];
  detail: Record<string, unknown> | null;
}

/**
 * Canonical sha256 hex digest over exactly what the operator sees on /jin
 * (#2152): `proposalId`, `source`, `kind`, `summary`, `keysTouched`, and
 * `detail`. Ingest independently recomputes this and rejects a mismatch —
 * the invariant is "what the operator saw is what gets applied", so a
 * `contentHash` that doesn't actually cover the delivered `detail` can
 * never be accepted.
 */
export function computeApprovalContentHash(fields: ContentHashFields): string {
  return createHash('sha256').update(canonicalize(fields)).digest('hex');
}

function normalizeContentHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const stripped = value.toLowerCase().startsWith('sha256:') ? value.slice(7) : value;
  return HEX64_PATTERN.test(stripped) ? stripped.toLowerCase() : null;
}

type ContentHashResult = { ok: true; contentHash: string | null } | { ok: false; error: string };

/**
 * Validate the optional/required `contentHash` (#2152). Required whenever
 * the request uses the open vocabulary (`source` and/or `detail` present)
 * so the hash-covers-detail invariant always holds for anything beyond the
 * original #2059 shape; optional (but still verified when present) for a
 * legacy bare-kind request, since that predates the concept entirely and
 * must keep ingesting unchanged.
 */
function validateContentHash(raw: unknown, required: boolean, fields: ContentHashFields): ContentHashResult {
  if (raw === undefined) {
    if (required) {
      return { ok: false, error: 'contentHash is required (sha256 hex digest) when source or detail is present' };
    }
    return { ok: true, contentHash: null };
  }
  const normalized = normalizeContentHash(raw);
  if (!normalized) {
    return { ok: false, error: 'contentHash must be a sha256 hex digest' };
  }
  if (normalized !== computeApprovalContentHash(fields)) {
    return { ok: false, error: 'contentHash does not match the canonical payload (including detail)' };
  }
  return { ok: true, contentHash: normalized };
}

/**
 * Validate an inbound `operator.approval.requested` payload at the notify
 * boundary. Rejects (never silently redacts) so the source gets an
 * actionable 400 instead of a partially-delivered card — a proposal is
 * either fully describable in key paths (+ bounded detail), or it must be
 * re-shaped before it reaches this API, never guessed at server-side.
 */
export function validateApprovalRequestedPayload(data: Record<string, unknown>): PayloadValidationResult {
  const { proposalId, summary, keysTouched } = data;

  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    return { ok: false, error: 'proposalId is required' };
  }

  const sourceKind = normalizeSourceAndKind(data);
  if (!sourceKind.ok) return { ok: false, error: sourceKind.error };

  if (typeof summary !== 'string' || summary.length === 0 || summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, error: 'summary is required (max 2000 chars)' };
  }
  if (looksLikeSecretValue(summary)) {
    return { ok: false, error: 'summary must not contain secret values' };
  }

  const keysResult = validateKeysTouched(keysTouched);
  if (!keysResult.ok) return keysResult;

  const detailResult = validateDetail(data.detail);
  if (!detailResult.ok) return detailResult;

  const normalizedKeysTouched = (keysTouched as string[] | undefined) ?? [];
  const isOpenVocabularyRequest = data.source !== undefined || detailResult.detail !== null;
  const contentHashResult = validateContentHash(data.contentHash, isOpenVocabularyRequest, {
    proposalId,
    source: sourceKind.source,
    kind: sourceKind.kind,
    summary,
    keysTouched: normalizedKeysTouched,
    detail: detailResult.detail,
  });
  if (!contentHashResult.ok) return contentHashResult;

  return {
    ok: true,
    source: sourceKind.source,
    kind: sourceKind.kind,
    detail: detailResult.detail,
    contentHash: contentHashResult.contentHash,
  };
}

function validateKeysTouched(keysTouched: unknown): { ok: true } | { ok: false; error: string } {
  if (!Array.isArray(keysTouched)) {
    return { ok: false, error: 'keysTouched must be an array of key paths' };
  }
  if (keysTouched.length > MAX_KEYS_TOUCHED) {
    return { ok: false, error: `keysTouched must have at most ${MAX_KEYS_TOUCHED} entries` };
  }
  const allValid = keysTouched.every(isValidKeyPath);
  if (!allValid) {
    return { ok: false, error: 'keysTouched must contain only key paths — never secret values' };
  }
  return { ok: true };
}

/**
 * Resolve the configured operator DID from `relay.relay_config.node_operator_did`
 * (see `apps/kernel/src/lib/kernel/node-identity.ts`, `scripts/bootstrap-
 * node-identity.ts`'s `NODE_OPERATOR_DID` seed) — the existing "who owns
 * this node" config, reused rather than adding a new env var per #2059's
 * instructions.
 */
export async function getOperatorDid(): Promise<string | null> {
  const info = await getNodeSelfInfo();
  return info?.nodeOperatorDid ?? null;
}

/**
 * The load-bearing auth rule (#2059): the decide action must be the HUMAN
 * operator identity authenticated directly, never delegated. `identity.id`
 * is the raw authenticated DID regardless of any acting-* overlay, so this
 * is false whenever the caller isn't the operator's own session — including
 * `@jin` (the agent) holding `X-Acting-For: <operatorDid>`, where `id` is
 * the agent's own DID, not the operator's. `actingFor` is checked
 * explicitly too, purely to make the invariant self-documenting at the one
 * call site that must never regress it.
 */
export function isOperatorIdentity(identity: Identity, operatorDid: string): boolean {
  return identity.id === operatorDid && !identity.actingFor;
}
