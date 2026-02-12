import { pgTable, uuid, varchar, timestamp, integer } from 'drizzle-orm/pg-core';

export const events = pgTable('imajin_ai_karaoke_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 255 }).unique().notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  location: varchar('location', { length: 255 }),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const participants = pgTable('imajin_ai_karaoke_participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  position: integer('position').notNull(),
  status: varchar('status', { length: 20 }).default('waiting').notNull(), // waiting | active | complete | skipped
  phone: varchar('phone', { length: 20 }),
  turnStart: timestamp('turn_start', { withTimezone: true }),
  turnEnd: timestamp('turn_end', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Types for use in app
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Participant = typeof participants.$inferSelect;
export type NewParticipant = typeof participants.$inferInsert;
