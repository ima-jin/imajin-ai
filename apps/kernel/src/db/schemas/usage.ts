import {
  pgSchema,
  text,
  timestamp,
  integer,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

export const usageSchema = pgSchema('usage');

// ---------------------------------------------------------------------------
// usage.incurred (#1923, Phase 3 of #1922)
//
// The shared Agent Resource-Accounting Layer stream: #1147/#1148 specify
// `usage.incurred` as ONE emitter/resource-agnostic table, and #1151 names
// the external emitters (Warp, Claude Code, provider-usage-API pulls,
// invoice reconciliation via #1076) that land in it alongside this one. This
// module — the completions passthrough (`POST /infer/v1/chat/completions`,
// #1925) — is emitter #1: every row it writes carries
// `source = 'inference-passthrough'` and `resource = 'model:{provider}/{model}'`.
//
// `provider`/`model`/`connectorId` stay as their own columns alongside
// `resource` — the spend-cap read path and its indexes key off them
// directly, so `resource` is the cross-emitter join key, not a replacement.
// Quantity/unit, attestation class, and the chain/rollup are #1148's
// remaining scope, added later.
//
// The money lives in `pay.transactions` (`service = 'inference'`) and the
// daily aggregate in `pay.balance_rollups` — see
// migrations/0119_usage_incurred.sql for the full division-of-responsibility
// note. Not a place to store cost/spend totals — those are derived by
// summing this table (spend-cap enforcement) or read from the pay schema
// (dashboard burn-down).
// ---------------------------------------------------------------------------

export const usageIncurred = usageSchema.table(
  'incurred',
  {
    id: text('id').primaryKey(),                          // usage_xxx (nanoid)
    sessionId: text('session_id'),                        // X-Session-Id header (OpenClaw); null when absent
    turnId: text('turn_id'),                              // X-Turn-Id header; null when absent
    principalDid: text('principal_did').notNull(),        // owner DID whose sealed card supplied the credential
    agentDid: text('agent_did'),                          // invoking app DID (onBehalfOf); null when the owner called directly
    // #1147 emitter id. This module always writes the same literal; other
    // emitters (#1151) and the reconciliation pass (#1076) write their own.
    source: text('source').notNull().default('inference-passthrough'),
    // #1147 typed discriminator: 'model:*' | 'tool:*' | 'infra:*' | 'external:*'.
    // This module always writes 'model:{provider}/{model}'.
    resource: text('resource').notNull(),
    provider: text('provider').notNull(),                 // BRAIN_CONNECTORS id, e.g. 'xai'
    connectorId: text('connector_id'),                    // kernel.connectors.id this call resolved credentials from
    model: text('model').notNull(),
    tokensIn: integer('tokens_in'),                       // null when the upstream response never reported usage
    tokensOut: integer('tokens_out'),
    costUsd: numeric('cost_usd', { precision: 20, scale: 8 }), // null when tokens are unknown or the model has no pricing entry
    // #1148: emitter-agnostic quantity/unit pair. This module writes
    // `quantity = tokensIn + tokensOut`, `unit = 'tokens'` whenever both
    // token counts are known; null alongside tokensIn/tokensOut otherwise.
    // Other emitters (#1151) fill these with their own resource's units.
    quantity: numeric('quantity', { precision: 24, scale: 6 }),
    unit: text('unit'),
    transactionId: text('transaction_id'),                // pay.transactions.id this call's spend was recorded under
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    principalIdx: index('idx_usage_incurred_principal').on(table.principalDid, table.createdAt),
    agentIdx: index('idx_usage_incurred_agent').on(table.agentDid, table.createdAt),
    sessionIdx: index('idx_usage_incurred_session').on(table.sessionId),
    turnIdx: index('idx_usage_incurred_turn').on(table.turnId),
    connectorIdx: index('idx_usage_incurred_connector').on(table.connectorId, table.createdAt),
    createdIdx: index('idx_usage_incurred_created').on(table.createdAt),
  }),
);

export type UsageIncurred = typeof usageIncurred.$inferSelect;
export type NewUsageIncurred = typeof usageIncurred.$inferInsert;
