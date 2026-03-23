import { pgTable, text, timestamp, jsonb, index, primaryKey, serial, uniqueIndex } from 'drizzle-orm/pg-core';
import { chatSchema } from './schema';

/**
 * Conversations v2 - DID as primary key
 * did:imajin:dm:<hash> or did:imajin:group:<hash>
 */
export const conversationsV2 = chatSchema.table('conversations_v2', {
  did: text('did').primaryKey(),                                // did:imajin:dm:xxx or did:imajin:group:xxx
  type: text('type').notNull().default('dm'),                   // 'dm' | 'group'
  parentDid: text('parent_did'),                                // Optional parent conversation DID
  name: text('name'),
  description: text('description'),
  avatar: text('avatar'),                                       // asset_xxx or URL
  context: jsonb('context').default({}),                        // Flexible metadata
  visibility: text('visibility').default('private'),            // 'private' | 'trust' | 'public'
  trustRadius: text('trust_radius'),
  podId: text('pod_id'),                                        // Link to connections.pods
  createdBy: text('created_by').notNull(),                      // DID of creator
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
}, (table) => ({
  createdByIdx: index('idx_chat_conv_v2_created_by').on(table.createdBy),
  parentDidIdx: index('idx_chat_conv_v2_parent_did').on(table.parentDid),
  lastMessageIdx: index('idx_chat_conv_v2_last_message').on(table.lastMessageAt),
}));

/**
 * Messages v2 - linked to DID-keyed conversations
 */
export const messagesV2 = chatSchema.table('messages_v2', {
  id: text('id').primaryKey(),                                  // msg_xxx
  conversationDid: text('conversation_did').references(() => conversationsV2.did, { onDelete: 'cascade' }).notNull(),
  fromDid: text('from_did').notNull(),

  // Threading
  replyToDid: text('reply_to_did'),                             // DID of conversation being replied to (for cross-conv replies)
  replyToMessageId: text('reply_to_message_id'),                // Message ID being replied to

  // Content
  content: jsonb('content').notNull(),                          // { encrypted, nonce } or { type: 'system', text }
  contentType: text('content_type').notNull().default('text'),  // 'text' | 'system' | 'media' | 'voice' | 'link'

  // Media attachments
  mediaType: text('media_type'),                                // 'image' | 'file' | 'audio' | null
  mediaPath: text('media_path'),
  mediaAssetId: text('media_asset_id'),                         // asset_xxx from media service (replaces mediaPath)
  mediaMeta: jsonb('media_meta'),                               // { width, height, size, originalName, mimeType, thumbnailPath }

  // Link previews
  linkPreviews: jsonb('link_previews'),                         // [{ url, title, description, image, favicon, siteName }]

  // Status
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  // Federation prep: Ed25519 signature over canonicalized { conversationDid, content, fromDid, createdAt }
  // Null when sender has no chain identity
  signature: text('signature'),
}, (table) => ({
  conversationDidIdx: index('idx_chat_msg_v2_conversation').on(table.conversationDid),
  fromDidIdx: index('idx_chat_msg_v2_from').on(table.fromDid),
  createdAtIdx: index('idx_chat_msg_v2_created').on(table.createdAt),
}));

/**
 * Message reactions v2
 */
export const messageReactionsV2 = chatSchema.table('message_reactions_v2', {
  messageId: text('message_id').references(() => messagesV2.id, { onDelete: 'cascade' }).notNull(),
  did: text('did').notNull(),
  emoji: text('emoji').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.messageId, table.did, table.emoji] }),
  messageIdx: index('idx_chat_react_v2_message').on(table.messageId),
}));

/**
 * Conversation reads v2 - tracks last read per DID
 */
export const conversationReadsV2 = chatSchema.table('conversation_reads_v2', {
  conversationDid: text('conversation_did').references(() => conversationsV2.did, { onDelete: 'cascade' }).notNull(),
  did: text('did').notNull(),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversationDid, table.did] }),
  didIdx: index('idx_chat_reads_v2_did').on(table.did),
}));

/**
 * Conversation members - tracks who is in a group conversation
 * DMs don't need this (membership is implicit in the deterministic DID).
 */
export const conversationMembers = chatSchema.table('conversation_members', {
  id: serial('id').primaryKey(),
  conversationDid: text('conversation_did').references(() => conversationsV2.did, { onDelete: 'cascade' }).notNull(),
  memberDid: text('member_did').notNull(),
  role: text('role').notNull().default('member'),               // 'owner' | 'admin' | 'member'
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  leftAt: timestamp('left_at', { withTimezone: true }),
}, (table) => ({
  memberIdx: index('idx_conv_members_member').on(table.memberDid),
  convIdx: index('idx_conv_members_conv').on(table.conversationDid),
  uniqueMember: uniqueIndex('idx_conv_members_unique').on(table.conversationDid, table.memberDid),
}));

// Types
export type ConversationMember = typeof conversationMembers.$inferSelect;
export type NewConversationMember = typeof conversationMembers.$inferInsert;
export type ConversationV2 = typeof conversationsV2.$inferSelect;
export type NewConversationV2 = typeof conversationsV2.$inferInsert;
export type MessageV2 = typeof messagesV2.$inferSelect;
export type NewMessageV2 = typeof messagesV2.$inferInsert;
export type MessageReactionV2 = typeof messageReactionsV2.$inferSelect;
export type ConversationReadV2 = typeof conversationReadsV2.$inferSelect;
