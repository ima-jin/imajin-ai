import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Identities - humans and agents with public keys
 */
export const identities = pgTable('auth_identities', {
  id: text('id').primaryKey(),                    // did:imajin:xxx
  type: text('type').notNull(),                   // 'human' | 'agent'
  publicKey: text('public_key').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Challenges - short-lived, for authentication flow
 */
export const challenges = pgTable('auth_challenges', {
  id: text('id').primaryKey(),
  identityId: text('identity_id').references(() => identities.id),
  challenge: text('challenge').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  expiresIdx: index('idx_auth_challenges_expires').on(table.expiresAt),
}));

/**
 * Tokens - issued after successful authentication
 */
export const tokens = pgTable('auth_tokens', {
  id: text('id').primaryKey(),                    // imajin_tok_xxx
  identityId: text('identity_id').references(() => identities.id).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => ({
  identityIdx: index('idx_auth_tokens_identity').on(table.identityId),
}));

// Types
export type Identity = typeof identities.$inferSelect;
export type NewIdentity = typeof identities.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type Token = typeof tokens.$inferSelect;
