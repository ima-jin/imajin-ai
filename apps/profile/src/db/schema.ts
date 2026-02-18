import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Profiles - public identity pages linked to DIDs
 */
export const profiles = pgTable('profiles', {
  did: text('did').primaryKey(),                              // did:imajin:xxx
  handle: text('handle').unique(),                            // unique handle (e.g., "jin", "ryan")
  displayName: text('display_name').notNull(),
  displayType: text('display_type').notNull(),                // 'human' | 'agent' | 'presence'
  avatar: text('avatar'),                                     // URL or emoji
  bio: text('bio'),
  invitedBy: text('invited_by'),                              // DID of inviter (no FK to avoid circular ref)
  metadata: jsonb('metadata').default({}),                    // location, website, etc.
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  handleIdx: index('idx_profiles_handle').on(table.handle),
  invitedByIdx: index('idx_profiles_invited_by').on(table.invitedBy),
  displayTypeIdx: index('idx_profiles_display_type').on(table.displayType),
}));

// Types
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
