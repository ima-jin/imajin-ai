import { pgSchema, text, boolean, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core';
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
