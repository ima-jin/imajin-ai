/**
 * Drizzle schema for the GitHub confirm rail (#1366).
 *
 * github.action_proposals — persists the three-state lifecycle of every
 * mutate write that passes through requireMutateGate():
 *
 *   pending  → awaiting human approval (surfaced to /jin dashboard)
 *   approved → human approved; approved_until controls single-call vs windowed
 *   done     → write executed; source of truth for rate-limit counting
 *
 * See migration 0073_github_action_proposals.sql for the full schema rationale.
 */
import { pgSchema, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

export const githubSchema = pgSchema('github');

export const githubActionProposals = githubSchema.table(
  'action_proposals',
  {
    /** proposal_{nanoid} */
    id: text('id').primaryKey(),
    /** DID of the resource owner */
    ownerDid: text('owner_did').notNull(),
    /** DID of the acting agent (optional, null when the owner acts directly) */
    agentDid: text('agent_did'),
    /** Connector scope — 'github:write' */
    scope: text('scope').notNull(),
    /** Tool name — 'github_update_issue' */
    tool: text('tool').notNull(),
    /** 'append' | 'mutate' */
    riskTier: text('risk_tier').notNull(),
    /** Human-readable write target, e.g. 'owner/repo#42' */
    target: text('target').notNull(),
    /** Human-readable summary of args — never raw secrets */
    argsSummary: text('args_summary').notNull(),
    /**
     * State machine:  pending → approved → done
     * Windowed rows:  approved row stays; each execution inserts a new done row.
     */
    status: text('status').notNull().default('pending'),
    /**
     * NULL  → single-call approval (consumed on next write)
     * SET   → windowed TTL (active until this timestamp)
     */
    approvedUntil: timestamp('approved_until', { withTimezone: true }),
    /**
     * Signed owner authorization — set at approve time.
     * Shape: { payload: { proposalId, ownerDid, tool, target, ttl, ts },
     *          signature: string, senderPubkey: string }
     */
    ownerAuthorization: jsonb('owner_authorization'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdx: index('idx_github_action_proposals_owner').on(table.ownerDid),
    statusIdx: index('idx_github_action_proposals_status').on(table.status),
    /** Supports live-grant lookup in requireMutateGate() */
    gateIdx: index('idx_github_action_proposals_gate').on(
      table.ownerDid,
      table.scope,
      table.riskTier,
      table.status,
    ),
    /** Supports rate-limit window count */
    doneWindowIdx: index('idx_github_action_proposals_done_window').on(
      table.ownerDid,
      table.status,
      table.createdAt,
    ),
  }),
);

export type GitHubActionProposal = typeof githubActionProposals.$inferSelect;
export type NewGitHubActionProposal = typeof githubActionProposals.$inferInsert;
