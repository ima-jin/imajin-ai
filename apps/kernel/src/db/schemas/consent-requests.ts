/**
 * Drizzle schema for the generic consent-request primitive (#1817).
 *
 * Generalizes the inference confirm gate (#1782/#1784/#1791 chain) and the
 * GitHub action-proposal rail (#1366/#1429) so any app-authed requester
 * holding `consent:write` can ask an approver DID to consent to one described
 * action — chat proposes, the canvas (a /jin confirm card) is authoritative.
 *
 * consent_requests.requests — one row per raised request:
 *
 *   pending  → awaiting the approver's decision; surfaced to /jin via the
 *              `consent.requested` bus event and the #1644/#1645 notify push.
 *   approved | rejected → resolved by a signed `approval.decision` in
 *              consent_requests.decisions (decision_id references it).
 *   expired  → resolved by the lazy expiry sweep once expires_at has passed,
 *              never left silently pending (#1817).
 *
 * consent_requests.decisions — kernel-witnessed attestation minted at decision
 * time, referencing the request id. Mirrors the node-signing pattern already
 * established for inference.attestations and the GitHub confirm route
 * (getNodeSigningIdentity + canonicalize + signSync).
 *
 * See migration 0109_consent_requests.sql for the full schema rationale.
 */
import { pgSchema, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

export const consentRequestsSchema = pgSchema('consent_requests');

export const consentRequests = consentRequestsSchema.table(
  'requests',
  {
    /** creq_{nanoid} */
    id: text('id').primaryKey(),
    /** DID of the app/system that raised the request. */
    requesterDid: text('requester_did').notNull(),
    /** DID of the subject who must approve or reject. */
    approverDid: text('approver_did').notNull(),
    /** Requester-vocabulary request kind, e.g. 'openclaw.exec_command'. */
    kind: text('kind').notNull(),
    /** Human-readable summary of exactly what will happen — what the card shows. */
    summary: text('summary').notNull(),
    /** Optional structured payload the card may render alongside the summary. */
    detail: jsonb('detail'),
    /** The granted scope that authorized raising this request (audit trail). */
    requesterScope: text('requester_scope').notNull(),
    /** State machine: pending → approved | rejected | expired. */
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** References consent_requests.decisions.id once resolved by a decision. */
    decisionId: text('decision_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Supports listing/looking up the approver's own pending cards. */
    approverIdx: index('idx_consent_requests_approver').on(table.approverDid, table.status),
    /** Supports a requester system polling the requests it raised. */
    requesterIdx: index('idx_consent_requests_requester').on(table.requesterDid, table.status),
    /** Supports the lazy expiry sweep: WHERE status='pending' AND expires_at <= now(). */
    expiryIdx: index('idx_consent_requests_expiry').on(table.status, table.expiresAt),
  }),
);

export type ConsentRequestRow = typeof consentRequests.$inferSelect;
export type NewConsentRequestRow = typeof consentRequests.$inferInsert;

export const consentDecisions = consentRequestsSchema.table(
  'decisions',
  {
    /** cdec_{nanoid} */
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    requesterDid: text('requester_did').notNull(),
    approverDid: text('approver_did').notNull(),
    /** 'approve' | 'reject' */
    decision: text('decision').notNull(),
    /**
     * Signed payload: { requestId, requesterDid, approverDid, kind, decision,
     * summaryDigest, ts }.
     */
    payload: jsonb('payload').notNull(),
    /** Ed25519 hex signature over canonicalize(payload). */
    signature: text('signature').notNull(),
    /** Hex-encoded Ed25519 public key of the signing node (kernel-witnessed). */
    senderPubkey: text('sender_pubkey').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    requestIdx: index('idx_consent_decisions_request').on(table.requestId),
    approverIdx: index('idx_consent_decisions_approver').on(table.approverDid),
  }),
);

export type ConsentDecisionRow = typeof consentDecisions.$inferSelect;
export type NewConsentDecisionRow = typeof consentDecisions.$inferInsert;
