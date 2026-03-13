import { pgTable, text, timestamp, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';
import { chatSchema } from './schema';

/**
 * Conversations v2 - DID as primary key
 * did:imajin:dm:<hash> or did:imajin:group:<hash>
 */
export const conversationsV2 = chatSchema.table('conversations_v2', {
  did: text('did').primaryKey(),                                // did:imajin:dm:xxx or did:imajin:group:xxx
  parentDid: text('parent_did'),                                // Optional parent conversation DID
  name: text('name'),
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
  mediaMeta: jsonb('media_meta'),                               // { width, height, size, originalName, mimeType, thumbnailPath }

  // Link previews
  linkPreviews: jsonb('link_previews'),                         // [{ url, title, description, image, favicon, siteName }]

  // Status
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
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

// Types
export type ConversationV2 = typeof conversationsV2.$inferSelect;
export type NewConversationV2 = typeof conversationsV2.$inferInsert;
export type MessageV2 = typeof messagesV2.$inferSelect;
export type NewMessageV2 = typeof messagesV2.$inferInsert;
export type MessageReactionV2 = typeof messageReactionsV2.$inferSelect;
export type ConversationReadV2 = typeof conversationReadsV2.$inferSelect;
