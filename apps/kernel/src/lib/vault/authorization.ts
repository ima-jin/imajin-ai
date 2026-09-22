/**
 * Vault proposal authorization reference (#2247, per Ryan's 2026-09-22
 * signing-roles ruling — epic #2084 "the wish-and-grant chain", shipped in
 * #2078 + PR #2158/#2082).
 *
 * Three signatures, three roles, for every vault:* canvas proposal:
 *   - The AGENT signs the WISH — the request itself + its `contentHash`
 *     (already covered by `computeApprovalContentHash` at proposal-raise
 *     time, #2152).
 *   - The HUMAN OPERATOR COUNTERSIGNS the DECISION over that hash,
 *     client-side (`operatorSignature` over `canonicalize({contentHash,
 *     decision, decidedAt})`, #2082, verified in `decideOperatorApproval`
 *     before the decision is ever persisted).
 *   - The NODE is WITNESS + EXECUTOR: it performs the mechanical action
 *     and signs the mechanical attestation (`vault.key.minted` /
 *     `.revoked` / `.withdrawn`) under its OWN identity — never the
 *     operator's — exactly as `requireMintAuthority` already requires for
 *     a direct `POST /api/vault/mint` call (precedent #1366/#1429: a
 *     mechanical attestation is issued by the platform/node identity, not
 *     the human who triggered it).
 *
 * `resolveVaultAuthorization` is the single choke point that builds the
 * audit-trail reference threaded onto the resulting attestation/event
 * (`authorizedBy`) and enforces the chain fails CLOSED: a vault mutation
 * never executes without a genuine, already-verified operator
 * countersignature on its decision — unconditionally, regardless of the
 * node-wide `OPERATOR_COUNTERSIGN_REQUIRED` flag (that flag governs the
 * generic, source-agnostic operator-approvals rail; vault mutations are
 * high-stakes enough to require the full three-signature chain always).
 * By the time this runs, `decideOperatorApproval` has already
 * cryptographically verified any supplied `operatorSignature` — this only
 * checks that one was actually supplied and the fields it covers are
 * present to record.
 */
import type { OperatorApprovalCard } from '../notify/operator-approvals-service';

/**
 * The operator-authorization reference recorded on a vault mechanical
 * attestation/event — never a substitute for `issuer_did` (always the
 * node), just the audit trail linking the mechanical action back to the
 * countersigned decision that authorized it.
 */
export interface VaultAuthorization {
  /** The operator-approvals `proposalId` this execution was authorized by. */
  approvalId: string;
  /** The operator DID who countersigned the decision. */
  operatorDid: string;
  /** The request's contentHash the operator's countersignature covers. */
  contentHash: string;
  /** The countersigned decision's timestamp. */
  decidedAt: string;
}

/**
 * Resolve the authorization reference for an approved vault:* card, or
 * `null` when the decision was never countersigned — the fail-closed gate
 * every vault execution path must check before performing any mutation.
 */
export function resolveVaultAuthorization(card: OperatorApprovalCard): VaultAuthorization | null {
  const decision = card.decision;
  if (!decision?.operatorSignature || !decision.decidedAt) {
    return null;
  }
  if (!card.contentHash) {
    return null;
  }
  return {
    approvalId: card.proposalId,
    operatorDid: decision.decidedBy,
    contentHash: card.contentHash,
    decidedAt: decision.decidedAt,
  };
}
