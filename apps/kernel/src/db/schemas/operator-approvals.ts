/**
 * Drizzle schema for operator approvals (#2059).
 *
 * Kernel half of "operator approvals appear as a signed confirm on /jin —
 * approve from anywhere": the OpenClaw plugin stages a Gateway proposal
 * (restart / config mutation) and publishes an `operator.approval.requested`
 * kernel notification (see `POST /notify/api/send`, scope
 * `operator.approval.requested`). This table is the durable lifecycle record
 * for that proposal, separate from the `notify.notifications` row that
 * carries it to /jin — the notification is transport (and gets backlog
 * redelivery for free, #2044/#2050), this table is the state machine:
 *
 *   pending       -> awaiting the operator's decision.
 *   approved      -> operator approved; "pending-apply" until the plugin
 *                    reports the proposal applied via the internal hook.
 *   denied        -> operator denied. Terminal.
 *   withdrawn     -> operator withdrew an approval before it was applied.
 *                    Only reachable from 'approved'. Terminal.
 *   applied       -> the plugin confirmed the Gateway applied the proposal.
 *                    Only reachable from 'approved'. Terminal.
 *
 * See migration 0130_operator_approvals.sql for the full schema rationale.
 */
import { pgSchema, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

export const operatorSchema = pgSchema('operator');

export const operatorApprovals = operatorSchema.table(
  'approvals',
  {
    /** Proposal id assigned by the OpenClaw system-agent — primary key. */
    proposalId: text('proposal_id').primaryKey(),
    /** The operator DID this proposal was addressed to (relay_config.node_operator_did at request time). */
    operatorDid: text('operator_did').notNull(),
    /** 'restart' | 'config-mutation' | 'other' */
    kind: text('kind').notNull(),
    /** Human-readable summary — never secret values (validated at the notify boundary). */
    summary: text('summary').notNull(),
    /** Key paths touched by the proposal — paths only, never resolved secret values. */
    keysTouched: jsonb('keys_touched').$type<string[]>().notNull().default([]),
    /** notify.notifications.id for the operator.approval.requested row, when known. */
    notificationId: text('notification_id'),
    /** State machine: pending -> approved | denied; approved -> withdrawn | applied. */
    status: text('status').notNull().default('pending'),
    /**
     * Signed decision payload once decided.
     * Shape: { payload: { proposalId, decision, decidedBy, decidedAt, reason? },
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
  }),
);

export type OperatorApprovalRow = typeof operatorApprovals.$inferSelect;
export type NewOperatorApprovalRow = typeof operatorApprovals.$inferInsert;
