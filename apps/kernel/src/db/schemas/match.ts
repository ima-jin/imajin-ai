import { pgSchema, text, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';

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
