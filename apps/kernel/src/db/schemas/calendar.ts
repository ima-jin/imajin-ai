import { pgSchema, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Calendar primitive — kernel-level temporal entries (Issue #241).
 *
 * The base type-agnostic row. Availability intent (#1099), meetings, events,
 * bookings, and reminders all build on this same row, differing only in
 * `type` and `metadata` ceremony. Visibility is broker-gated.
 */
export const calendarSchema = pgSchema('kernel');

export const calendarEntries = calendarSchema.table('calendar_entries', {
  id: text('id').primaryKey(),
  did: text('did').notNull(),                                   // owner DID
  type: text('type').notNull(),                                 // 'availability' | 'meeting' | 'event' | 'booking' | 'reminder' | 'block'
  title: text('title'),
  activityTags: text('activity_tags').array(),
  startsAt: timestamp('starts_at', { withTimezone: true }),     // null = open-ended
  endsAt: timestamp('ends_at', { withTimezone: true }),         // null = open-ended
  expiresAt: timestamp('expires_at', { withTimezone: true }),   // TTL — auto-cleanup for transient entries
  visibility: text('visibility').notNull().default('private'),  // 'public' | 'connections' | 'selective' | 'private'
  visibilityDids: text('visibility_dids').array(),              // for selective: specific DIDs that can see this
  recurrence: jsonb('recurrence'),                              // future: rrule-style recurrence
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  didIdx: index('idx_calendar_entries_did').on(table.did),
  didTimeIdx: index('idx_calendar_entries_did_time').on(table.did, table.startsAt, table.endsAt),
  typeIdx: index('idx_calendar_entries_type').on(table.did, table.type),
  expiresIdx: index('idx_calendar_entries_expires').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
}));

export type CalendarEntry = typeof calendarEntries.$inferSelect;
export type NewCalendarEntry = typeof calendarEntries.$inferInsert;
