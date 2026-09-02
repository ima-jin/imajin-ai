import {
  pgSchema,
  text,
  timestamp,
  integer,
  bigint,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
    // #1151 dedupe key: an external emitter's own idempotency key for the
    // underlying event (e.g. a Claude Code session-JSONL message uuid). Null
    // for the passthrough emitter, whose calls are already exactly-once.
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    principalIdx: index('idx_usage_incurred_principal').on(table.principalDid, table.createdAt),
    agentIdx: index('idx_usage_incurred_agent').on(table.agentDid, table.createdAt),
    sessionIdx: index('idx_usage_incurred_session').on(table.sessionId),
    turnIdx: index('idx_usage_incurred_turn').on(table.turnId),
    connectorIdx: index('idx_usage_incurred_connector').on(table.connectorId, table.createdAt),
    createdIdx: index('idx_usage_incurred_created').on(table.createdAt),
    // #1151 dedupe: partial unique index (see migrations/0121_usage_emitters.sql)
    // so re-tailing/re-polling an external emitter can never double-count.
    sourceExternalIdUniq: uniqueIndex('uniq_usage_incurred_source_external_id')
      .on(table.source, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
  }),
);

export type UsageIncurred = typeof usageIncurred.$inferSelect;
export type NewUsageIncurred = typeof usageIncurred.$inferInsert;

// usage.emitters (#1151)
//
// Registry of every source allowed to write into usage.incurred, other than
// the completions passthrough (which is seeded as a row here too, in
// migrations/0121_usage_emitters.sql, even though it writes usage.incurred
// directly rather than through POST /usage/api/incurred). See that
// migration's header for the full column-by-column rationale.
// ---------------------------------------------------------------------------

export const usageEmitters = usageSchema.table(
  'emitters',
  {
    source: text('source').primaryKey(),           // usage.incurred.source this row governs, e.g. 'adapter:claude-code'
    reader: text('reader').notNull(),               // 'tail-jsonl' | 'push' | 'internal' | ...
    issuerDid: text('issuer_did').notNull(),         // DID this emitter is registered by; checked against the ingest caller
    actingFor: text('acting_for'),                   // DID this emitter reports spend on behalf of, when it differs from issuerDid
    keyField: text('key_field'),                     // vault FIELD NAME the reader needs, if any — a reference, never a credential
    cadence: text('cadence'),                        // free-text cadence hint for polling/batch readers
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('active'), // 'active' | 'revoked'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuerIdx: index('idx_usage_emitters_issuer').on(table.issuerDid, table.status),
    keyFieldIdx: index('idx_usage_emitters_key_field')
      .on(table.keyField)
      .where(sql`${table.keyField} IS NOT NULL`),
  }),
);

export type UsageEmitter = typeof usageEmitters.$inferSelect;
export type NewUsageEmitter = typeof usageEmitters.$inferInsert;

// ---------------------------------------------------------------------------
// usage.billed (Stage 1 of #1076)
//
// The COUNTERPARTY'S STATEMENT — what a provider's own admin/usage/cost API
// says we were actually charged, kept in its own table and reconciled
// against `usage.incurred` (OUR meter) at read time, never merged into it.
// See migrations/0122_usage_billed.sql for the full framing note and the
// division of responsibility against #1148 (migration 0120) and #1151
// (migration 0121), neither of which this table touches.
// ---------------------------------------------------------------------------

export const usageBilled = usageSchema.table(
  'billed',
  {
    id: text('id').primaryKey(),                          // billed_xxx (nanoid)
    principalDid: text('principal_did').notNull(),        // owner DID whose sealed admin/billing key was used
    provider: text('provider').notNull(),                 // 'anthropic' | 'openai'
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    granularity: text('granularity').notNull(),           // 'day' | 'month'
    model: text('model'),                                 // nullable: providers report per-model where available
    tokensIn: bigint('tokens_in', { mode: 'number' }),
    tokensOut: bigint('tokens_out', { mode: 'number' }),
    billedUsd: numeric('billed_usd', { precision: 20, scale: 8 }),
    raw: jsonb('raw'),                                    // the provider's line item verbatim, for audit
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Idempotent upsert target on re-fetch — see the migration's comment on
    // why COALESCE(model, '') rather than a bare column.
    periodUniq: uniqueIndex('uniq_usage_billed_period')
      .on(table.principalDid, table.provider, table.periodStart, table.granularity, sql`COALESCE(${table.model}, '')`),
    principalIdx: index('idx_usage_billed_principal').on(table.principalDid, table.provider, table.periodStart),
    fetchedIdx: index('idx_usage_billed_fetched').on(table.fetchedAt),
  }),
);

export type UsageBilled = typeof usageBilled.$inferSelect;
export type NewUsageBilled = typeof usageBilled.$inferInsert;
