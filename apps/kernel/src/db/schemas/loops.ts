import { pgSchema, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * #2295 — kernel loop registry (epic #2288/#2290).
 *
 * Written from packages/bus's `loop-projection` reactor via raw SQL (see
 * packages/bus/AGENTS.md — bus must not import apps/kernel's Drizzle
 * schema). Mirrored here — same convention as `auditLog`/`eventSubscriptionLog`
 * in `./bus.ts` — purely for kernel-side reads (`GET /api/loops`,
 * `GET /api/loops/:loopId`). See migrations/0157_loops_rail.sql for the
 * physical tables this maps onto; this is a read mapping only.
 */
export const loopsSchema = pgSchema('kernel');

/** Current-state-per-loopId projection. `parentLoopId` is the lineage column the ancestor query walks. */
export const loops = loopsSchema.table('loops', {
  loopId: text('loop_id').primaryKey(),
  kind: text('kind').notNull(),
  principal: text('principal').notNull(),
  parentLoopId: text('parent_loop_id'),
  refs: jsonb('refs').notNull().default({}),
  state: text('state').notNull(),
  summary: text('summary').notNull(),
  lastEventType: text('last_event_type').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  principalIdx: index('idx_loops_principal').on(table.principal, table.lastSeenAt),
  parentIdx: index('idx_loops_parent').on(table.parentLoopId).where(sql`${table.parentLoopId} IS NOT NULL`),
  kindIdx: index('idx_loops_kind').on(table.kind),
  stateIdx: index('idx_loops_state').on(table.state),
}));

export type LoopRow = typeof loops.$inferSelect;
export type NewLoopRow = typeof loops.$inferInsert;

/** Immutable per-transition history — one row per loop.* event actually ingested. */
export const loopEvents = loopsSchema.table('loop_events', {
  id: text('id').primaryKey(),
  loopId: text('loop_id').notNull(),
  type: text('type').notNull(),
  issuer: text('issuer').notNull(),
  principal: text('principal').notNull(),
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  loopIdIdx: index('idx_loop_events_loop_id').on(table.loopId, table.occurredAt),
  principalIdx: index('idx_loop_events_principal').on(table.principal, table.occurredAt),
}));

export type LoopEventRow = typeof loopEvents.$inferSelect;
export type NewLoopEventRow = typeof loopEvents.$inferInsert;
