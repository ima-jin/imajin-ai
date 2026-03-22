import { pgTable, text, timestamp, boolean, index, pgSchema } from 'drizzle-orm/pg-core';

export const chatSchema = pgSchema('chat');

/**
 * Invites - for joining group conversations
 * conversationId references a conversation DID (v2) as plain text.
 * TODO(#435-followup): drop the FK constraint from the old conversations table.
 */
export const invites = chatSchema.table('invites', {
  id: text('id').primaryKey(),                                  // inv_xxx
  conversationId: text('conversation_id').notNull(),            // conversation DID or legacy conv id

  // Who can use this invite
  createdBy: text('created_by').notNull(),                      // DID who created invite
  forDid: text('for_did'),                                      // Specific DID (null = anyone with link)

  // Constraints
  maxUses: text('max_uses'),                                    // null = unlimited
  usedCount: text('used_count').notNull().default('0'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  // Status
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  conversationIdx: index('idx_chat_invites_conversation').on(table.conversationId),
  forDidIdx: index('idx_chat_invites_for_did').on(table.forDid),
}));

/**
 * Public keys for E2EE
 */
export const publicKeys = chatSchema.table('public_keys', {
  did: text('did').primaryKey(),
  identityKey: text('identity_key').notNull(),                  // Long-term X25519 public key
  signedPreKey: text('signed_pre_key').notNull(),               // Signed pre-key
  signature: text('signature').notNull(),                       // Signature of signed pre-key
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * One-time pre-keys for forward secrecy
 */
export const preKeys = chatSchema.table('pre_keys', {
  id: text('id').primaryKey(),
  did: text('did').references(() => publicKeys.did, { onDelete: 'cascade' }).notNull(),
  key: text('key').notNull(),
  used: boolean('used').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_chat_pre_keys_did').on(table.did),
}));

// Types
export type Invite = typeof invites.$inferSelect;
export type PublicKey = typeof publicKeys.$inferSelect;
