import { pgSchema, text, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Match records — spent-forever tracking for the bilateral match engine (#1102).
 *
 * One row per matched intent PAIR, ever. UNIQUE(intent_a, intent_b) is the
 * spent-enforcement: the engine does INSERT ... ON CONFLICT → skip if already spent.
 * intent_a/intent_b are canonically ordered (lesser id first) so (A,B) == (B,A).
 */
export const matchSchema = pgSchema('kernel');

export const matchRecords = matchSchema.table('match_records', {
  id: text('id').primaryKey(),
  intentA: text('intent_a').notNull(),    // lesser of the two intent ids
  intentB: text('intent_b').notNull(),    // greater of the two intent ids
  overlapTags: text('overlap_tags').array().notNull(),
  sensitive: boolean('sensitive').notNull().default(false),
  matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  intentAIdx: index('idx_match_records_intent_a').on(table.intentA),
  intentBIdx: index('idx_match_records_intent_b').on(table.intentB),
  pairUnique: unique('uniq_match_records_pair').on(table.intentA, table.intentB),
}));

export type MatchRecord = typeof matchRecords.$inferSelect;
export type NewMatchRecord = typeof matchRecords.$inferInsert;

/**
 * Match notifications — delivery queue for the broker agent.
 * Written by the notify-match-delivery reactor when a match is surfaced;
 * read and cleared by the bot when it delivers to the recipient's chat.
 */
export const matchNotifications = matchSchema.table('match_notifications', {
  id: text('id').primaryKey(),
  matchId: text('match_id').notNull(),
  recipientDid: text('recipient_did').notNull(),
  otherDid: text('other_did'),                       // null if sensitive_staged
  overlapTags: text('overlap_tags').array().notNull(),
  isSensitive: boolean('is_sensitive').notNull().default(false),
  deliveryPolicy: text('delivery_policy').notNull(), // 'named_nudge' | 'staged' | 'sensitive_staged'
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pendingIdx: index('idx_match_notifications_recipient').on(table.recipientDid, table.deliveredAt).where(sql`${table.deliveredAt} IS NULL`),
  createdIdx: index('idx_match_notifications_created').on(table.createdAt),
}));

export type MatchNotification = typeof matchNotifications.$inferSelect;
export type NewMatchNotification = typeof matchNotifications.$inferInsert;
