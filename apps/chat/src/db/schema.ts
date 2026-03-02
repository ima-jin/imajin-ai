import { pgTable, text, timestamp, jsonb, boolean, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Conversations - both direct messages and groups
 */
export const conversations = pgTable('chat_conversations', {
  id: text('id').primaryKey(),                                  // conv_xxx
  type: text('type').notNull(),                                 // 'direct' | 'group'
  name: text('name'),                                           // For groups
  description: text('description'),                             // Group description
  avatar: text('avatar'),                                       // Group avatar URL/emoji
  
  // Context - links chat to events, orgs, etc.
  context: jsonb('context'),                                    // { type: 'event' | 'org' | 'project', id: 'xxx' }

  // Trust pod integration
  podId: text('pod_id'),                                        // Links to trust_pods.id

  // Visibility & access
  visibility: text('visibility').notNull().default('private'),  // 'private' | 'trust-bound'
  trustRadius: text('trust_radius'),                            // For trust-bound: max hops
  
  // Ownership
  createdBy: text('created_by').notNull(),                      // DID of creator
  
  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
}, (table) => ({
  typeIdx: index('idx_chat_conversations_type').on(table.type),
  createdByIdx: index('idx_chat_conversations_created_by').on(table.createdBy),
  podIdx: index('idx_chat_conversations_pod_id').on(table.podId),
}));

/**
 * Participants in conversations
 */
export const participants = pgTable('chat_participants', {
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  did: text('did').notNull(),
  
  // Role & permissions
  role: text('role').notNull().default('member'),               // 'owner' | 'admin' | 'member' | 'readonly'
  
  // Status
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
  invitedBy: text('invited_by'),                                // DID who invited them
  lastReadAt: timestamp('last_read_at', { withTimezone: true }),
  muted: boolean('muted').default(false),
  
  // For cross-graph trust building
  trustExtendedTo: jsonb('trust_extended_to').default([]),      // DIDs this participant has extended trust to in this group
}, (table) => ({
  pk: primaryKey({ columns: [table.conversationId, table.did] }),
  didIdx: index('idx_chat_participants_did').on(table.did),
  roleIdx: index('idx_chat_participants_role').on(table.role),
}));

/**
 * Messages
 */
export const messages = pgTable('chat_messages', {
  id: text('id').primaryKey(),                                  // msg_xxx
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  fromDid: text('from_did').notNull(),
  
  // Content (E2EE)
  content: jsonb('content').notNull(),                          // { encrypted, nonce } or { type: 'system', text }
  contentType: text('content_type').notNull().default('text'),  // 'text' | 'system' | 'invite' | 'trust-extended'
  
  // Threading
  replyTo: text('reply_to'),                                    // Message ID
  
  // Status
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  conversationIdx: index('idx_chat_messages_conversation').on(table.conversationId),
  createdIdx: index('idx_chat_messages_created').on(table.createdAt),
  fromDidIdx: index('idx_chat_messages_from').on(table.fromDid),
}));

/**
 * Invites - for joining groups
 */
export const invites = pgTable('chat_invites', {
  id: text('id').primaryKey(),                                  // inv_xxx
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  
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
export const publicKeys = pgTable('chat_public_keys', {
  did: text('did').primaryKey(),
  identityKey: text('identity_key').notNull(),                  // Long-term X25519 public key
  signedPreKey: text('signed_pre_key').notNull(),               // Signed pre-key
  signature: text('signature').notNull(),                       // Signature of signed pre-key
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * One-time pre-keys for forward secrecy
 */
export const preKeys = pgTable('chat_pre_keys', {
  id: text('id').primaryKey(),
  did: text('did').references(() => publicKeys.did, { onDelete: 'cascade' }).notNull(),
  key: text('key').notNull(),
  used: boolean('used').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_chat_pre_keys_did').on(table.did),
}));

/**
 * Read receipts (separate for performance)
 */
export const readReceipts = pgTable('chat_read_receipts', {
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  did: text('did').notNull(),
  lastReadMessageId: text('last_read_message_id').references(() => messages.id),
  readAt: timestamp('read_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversationId, table.did] }),
}));

/**
 * Message reactions
 */
export const messageReactions = pgTable('chat_message_reactions', {
  messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  did: text('did').notNull(),
  emoji: text('emoji').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.messageId, table.did, table.emoji] }),
  messageIdx: index('idx_chat_message_reactions_message').on(table.messageId),
}));

// Types
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Participant = typeof participants.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type PublicKey = typeof publicKeys.$inferSelect;
export type MessageReaction = typeof messageReactions.$inferSelect;
