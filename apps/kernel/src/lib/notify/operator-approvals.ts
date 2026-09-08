/**
 * Operator approvals — contract types and payload validation (#2059).
 *
 * Kernel half of "operator approvals (gateway restart / config proposals)
 * appear as a signed confirm on /jin — approve from anywhere". Two kernel
 * notification kinds make up the contract with the OpenClaw plugin
 * (ima-jin/openclaw-imajin-plugin#24, a separate repo/process — this module
 * defines what it implements against, never imports it):
 *
 *   operator.approval.requested — the plugin, on behalf of the OpenClaw
 *     system-agent, publishes this via `POST /notify/api/send` (the same
 *     webhook-secret-gated ingestion every other notify scope uses) when a
 *     proposal (gateway restart / config mutation) is staged. Renders as a
 *     confirm card on /jin. NEVER carries secret values — only key PATHS
 *     the proposal touches (see {@link validateApprovalRequestedPayload}).
 *
 *   operator.approval.decided — the kernel publishes this via `bus.publish`
 *     once the operator taps Approve/Deny (or withdraws) on /jin. Delivered
 *     to the plugin over its existing authenticated WS via the #1884
 *     grant-bound event-subscription fan-out (packages/bus/src/
 *     subscriptions.ts) — the plugin's agent DID needs an active grant for
 *     the `operator:approvals` capability (packages/auth/src/grant-
 *     scopes.ts) to receive it live; it can always catch up via
 *     `kernel.event_subscription_log` otherwise. Attestation-shaped: who
 *     decided, what proposal, when, and why (optional).
 *
 * See docs/notify/operator-approvals-contract.md for the full contract
 * doc aimed at the plugin implementation.
 */
import type { Identity } from '@imajin/auth';
import { getNodeSelfInfo } from '@/src/lib/kernel/node-identity';

export const OPERATOR_APPROVAL_REQUESTED_SCOPE = 'operator.approval.requested';

export type ApprovalProposalKind = 'restart' | 'config-mutation' | 'other';
export type ApprovalRequestAction = 'approve' | 'deny';
export type ApprovalDecision = 'approve' | 'deny' | 'withdrawn';

/** The `operator.approval.requested` notification payload (the /jin card). */
export interface OperatorApprovalRequestedPayload {
  proposalId: string;
  kind: ApprovalProposalKind;
  summary: string;
  /** Key paths the proposal touches — paths only, never resolved values. */
  keysTouched: string[];
  actions: readonly ApprovalRequestAction[];
}

/** The signed `operator.approval.decided` event payload. */
export interface OperatorApprovalDecidedPayload {
  proposalId: string;
  decision: ApprovalDecision;
  decidedBy: string;
  decidedAt: string;
  reason?: string;
}

const VALID_KINDS = new Set<ApprovalProposalKind>(['restart', 'config-mutation', 'other']);
export const REQUEST_ACTIONS: readonly ApprovalRequestAction[] = ['approve', 'deny'] as const;

/** A key path is a short, plain identifier chain — never a resolved value. */
const KEY_PATH_PATTERN = /^\w[\w.\-/]{0,199}$/;
const MAX_KEYS_TOUCHED = 50;
const MAX_SUMMARY_LENGTH = 2000;

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
}

/**
 * Validate an inbound `operator.approval.requested` payload at the notify
 * boundary. Rejects (never silently redacts) so the plugin gets an
 * actionable 400 instead of a partially-delivered card — a proposal is
 * either fully describable in key paths, or it must be re-shaped before it
 * reaches this API, never guessed at server-side.
 */
export function validateApprovalRequestedPayload(data: Record<string, unknown>): PayloadValidationResult {
  const { proposalId, kind, summary, keysTouched } = data;

  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    return { ok: false, error: 'proposalId is required' };
  }
  if (typeof kind !== 'string' || !VALID_KINDS.has(kind as ApprovalProposalKind)) {
    return { ok: false, error: "kind must be one of 'restart' | 'config-mutation' | 'other'" };
  }
  if (typeof summary !== 'string' || summary.length === 0 || summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, error: 'summary is required (max 2000 chars)' };
  }
  if (looksLikeSecretValue(summary)) {
    return { ok: false, error: 'summary must not contain secret values' };
  }
  return validateKeysTouched(keysTouched);
}

function validateKeysTouched(keysTouched: unknown): PayloadValidationResult {
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
