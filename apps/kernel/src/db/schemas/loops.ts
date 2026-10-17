import { pgSchema, text, jsonb, timestamp, index, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import type { LoopOutput } from '@imajin/bus';
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
  refsIdx: index('idx_loops_refs').using('gin', table.refs.op('jsonb_path_ops')),
  runIdx: index('idx_loops_principal_run').on(table.principal, sql`(${table.refs}->>'runId')`),
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
  sessionIdx: index('idx_loop_events_principal_session').on(table.principal, sql`(${table.payload}->'refs'->>'sessionKey')`),
  principalIdx: index('idx_loop_events_principal').on(table.principal, table.occurredAt),
}));

export type LoopEventRow = typeof loopEvents.$inferSelect;
export type NewLoopEventRow = typeof loopEvents.$inferInsert;

/** Private output storage; readers must filter principal AND loop. */
export const loopOutputArtifacts = loopsSchema.table('loop_output_artifacts', {
  id: text('id').primaryKey(),
  loopId: text('loop_id').notNull(),
  principal: text('principal').notNull(),
  sha256: text('sha256').notNull(),
  byteLength: integer('byte_length').notNull(),
  mediaType: text('media_type').notNull().default('application/json'),
  content: jsonb('content').$type<LoopOutput>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  scopeHashIdx: uniqueIndex('idx_loop_output_artifacts_scope_hash').on(table.principal, table.loopId, table.sha256),
}));
/** #2405 — one advisory holder per typed surface, with original signed evidence. */
export const surfaceLease = loopsSchema.table('surface_lease', {
  surface: text('surface').primaryKey(),
  loopId: text('loop_id').notNull(),
  principal: text('principal').notNull(),
  issuer: text('issuer').notNull(),
  signature: jsonb('signature').notNull(),
  signedPayload: jsonb('signed_payload').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  principalIdx: index('idx_surface_lease_principal').on(table.principal, table.expiresAt),
  loopIdx: index('idx_surface_lease_loop').on(table.loopId, table.principal, table.issuer),
}));
