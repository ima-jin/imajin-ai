import { pgSchema, text, boolean, timestamp, jsonb, index, unique, bigserial } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const busSchema = pgSchema('kernel');

export const busChainConfigs = busSchema.table('bus_chain_configs', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  scope: text('scope'),
  reactors: jsonb('reactors').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  eventTypeIdx: index('idx_bus_chain_configs_event_type').on(table.eventType),
  scopeIdx: index('idx_bus_chain_configs_scope').on(table.scope).where(sql`${table.scope} IS NOT NULL`),
  eventTypeScopeUnique: unique('uniq_bus_chain_configs_event_type_scope').on(table.eventType, table.scope),
}));

export type BusChainConfig = typeof busChainConfigs.$inferSelect;
export type NewBusChainConfig = typeof busChainConfigs.$inferInsert;

// ---------------------------------------------------------------------------
// #1136 — supply-chain lot + stage spine (kernel.supply_lots / supply_stages).
// Materializes a lot and its ordered stages keyed by correlationId so a supply
// chain (declared -> collected -> processed -> listed -> settled) is queryable
// as one ordered history. Generic: commodity-specific detail lives in the stage
// payload + attestations, not in columns.
// ---------------------------------------------------------------------------

export const supplyLots = busSchema.table('supply_lots', {
  correlationId: text('correlation_id').primaryKey(),
  originatingDid: text('originating_did').notNull(),
  commodity: text('commodity'),
  status: text('status').notNull().default('open'),
  fairManifest: jsonb('fair_manifest'),
  buyerDid: text('buyer_did'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const supplyStages = busSchema.table('supply_stages', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  // seq is a monotonic insertion-order tiebreaker (0072_supply_stages_seq).
  // Use seq DESC in ORDER BY instead of the non-monotonic random-UUID id.
  seq: bigserial('seq', { mode: 'bigint' }).notNull(),
  correlationId: text('correlation_id').notNull().references(() => supplyLots.correlationId),
  stage: text('stage').notNull(),
  actorDid: text('actor_did').notNull(),
  attestationCid: text('attestation_cid'),
  priorCid: text('prior_cid'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  correlationCreatedIdx: index('idx_supply_stages_correlation_created').on(table.correlationId, table.createdAt),
  correlationSeqIdx: index('idx_supply_stages_correlation_seq').on(table.correlationId, table.seq),
}));

export type SupplyLot = typeof supplyLots.$inferSelect;
export type NewSupplyLot = typeof supplyLots.$inferInsert;
export type SupplyStage = typeof supplyStages.$inferSelect;
export type NewSupplyStage = typeof supplyStages.$inferInsert;
