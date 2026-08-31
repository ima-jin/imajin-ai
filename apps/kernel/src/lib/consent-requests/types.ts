/**
 * Generic consent-request primitive — shared types (#1817).
 *
 * ConsentRequestCard is the "card payload" a /jin confirm card renders from:
 * requester DID, approver DID, kind, human-readable summary, request id, and
 * expiry, per the issue's shape. ConsentDecisionAttestation is the
 * kernel-witnessed record minted when the approver taps Approve/Reject.
 */

export type ConsentRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type ConsentDecisionType = 'approve' | 'reject';

export type ConsentRequestRole = 'approver' | 'requester';

/** The full card payload rendered on /jin — exactly what is being approved. */
export interface ConsentRequestCard {
  id: string;
  requesterDid: string;
  approverDid: string;
  kind: string;
  summary: string;
  detail: Record<string, unknown> | null;
  status: ConsentRequestStatus;
  expiresAt: string;
  resolvedAt: string | null;
  decisionId: string | null;
  createdAt: string;
}

/** The signed approval.decision attestation, kernel-witnessed. */
export interface ConsentDecisionAttestation {
  id: string;
  requestId: string;
  requesterDid: string;
  approverDid: string;
  decision: ConsentDecisionType;
  payload: Record<string, unknown>;
  signature: string;
  senderPubkey: string;
  signedAt: string;
}
