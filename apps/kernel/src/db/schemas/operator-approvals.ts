/**
 * Drizzle schema for operator approvals (#2059, generalized to an open
 * source/kind vocabulary by #2152).
 *
 * Kernel half of "operator approvals appear as a signed confirm on /jin —
 * approve from anywhere": a source (e.g. the OpenClaw plugin's system-agent
 * or skill-workshop adapter) stages a proposal and publishes an
 * `operator.approval.requested` kernel notification (see `POST
 * /notify/api/send`, scope `operator.approval.requested`). This table is
 * the durable lifecycle record for that proposal, separate from the
 * `notify.notifications` row that carries it to /jin — the notification is
 * transport (and gets backlog redelivery for free, #2044/#2050), this
 * table is the state machine:
 *
 *   pending       -> awaiting the operator's decision.
 *   approved      -> operator approved; "pending-apply" until the source
 *                    reports the proposal applied via the internal hook.
 *   denied        -> operator rejected. Terminal.
 *   withdrawn     -> operator withdrew an approval before it was applied.
 *                    Only reachable from 'approved'. Terminal.
 *   applied       -> the source confirmed the proposal was applied.
 *                    Only reachable from 'approved'. Terminal.
 *
 * See migration 0130_operator_approvals.sql and
 * 0132_operator_approvals_generic_source.sql for the full schema rationale.
 */
import { pgSchema, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

export const operatorSchema = pgSchema('operator');

export const operatorApprovals = operatorSchema.table(
  'approvals',
  {
    /** Proposal id assigned by the raising source — primary key. */
    proposalId: text('proposal_id').primaryKey(),
    /** The operator DID this proposal was addressed to (relay_config.node_operator_did at request time). */
    operatorDid: text('operator_did').notNull(),
    /** Open vocabulary namespace, e.g. 'system-agent', 'skill-workshop' (#2152). */
    source: text('source').notNull().default('system-agent'),
    /** '<source>:<subkind>', e.g. 'system-agent:restart' | 'skill-workshop:update' — legacy bare kinds normalize here (#2152). */
    kind: text('kind').notNull(),
    /** Human-readable summary — never secret values (validated at the notify boundary). */
    summary: text('summary').notNull(),
    /** Key paths touched by the proposal — paths only, never resolved secret values. */
    keysTouched: jsonb('keys_touched').$type<string[]>().notNull().default([]),
    /** Optional, bounded (<=16KB) per-source structured detail — e.g. skill-workshop's diff summary (#2152). */
    detail: jsonb('detail').$type<Record<string, unknown> | null>(),
    /** sha256 hex digest covering {proposalId,source,kind,summary,keysTouched,detail}, when supplied (#2152). */
    contentHash: text('content_hash'),
    /** notify.notifications.id for the operator.approval.requested row, when known. */
    notificationId: text('notification_id'),
    /** State machine: pending -> approved | denied; approved -> withdrawn | applied. */
    status: text('status').notNull().default('pending'),
    /**
     * Signed decision payload once decided.
     * Shape: { payload: { proposalId, source, kind, decision, mode?, decidedBy, decidedAt, reason? },
     *          signature: string, senderPubkey: string }
     */
    decision: jsonb('decision'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operatorIdx: index('idx_operator_approvals_operator').on(table.operatorDid, table.status),
    statusIdx: index('idx_operator_approvals_status').on(table.status),
    sourceIdx: index('idx_operator_approvals_source').on(table.source, table.status),
  }),
);

export type OperatorApprovalRow = typeof operatorApprovals.$inferSelect;
export type NewOperatorApprovalRow = typeof operatorApprovals.$inferInsert;
