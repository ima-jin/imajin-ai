import { pgTable, pgSchema, index, text, jsonb, timestamp, foreignKey, boolean, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const chat = pgSchema("chat");


export const conversationsInChat = chat.table("conversations", {
	id: text().primaryKey().notNull(),
	type: text().notNull(),
	name: text(),
	description: text(),
	avatar: text(),
	context: jsonb(),
	visibility: text().default('private').notNull(),
	trustRadius: text("trust_radius"),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: 'string' }),
	podId: text("pod_id"),
}, (table) => [
	index("idx_chat_conversations_created_by").using("btree", table.createdBy.asc().nullsLast().op("text_ops")),
	index("idx_chat_conversations_pod_id").using("btree", table.podId.asc().nullsLast().op("text_ops")),
	index("idx_chat_conversations_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
]);

export const messagesInChat = chat.table("messages", {
	id: text().primaryKey().notNull(),
	conversationId: text("conversation_id").notNull(),
	fromDid: text("from_did").notNull(),
	content: jsonb().notNull(),
	contentType: text("content_type").default('text').notNull(),
	replyTo: text("reply_to"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	editedAt: timestamp("edited_at", { withTimezone: true, mode: 'string' }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	mediaType: text("media_type"),
	mediaPath: text("media_path"),
	mediaMeta: jsonb("media_meta"),
	linkPreviews: jsonb("link_previews"),
}, (table) => [
	index("idx_chat_messages_conversation").using("btree", table.conversationId.asc().nullsLast().op("text_ops")),
	index("idx_chat_messages_created").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_chat_messages_from").using("btree", table.fromDid.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversationsInChat.id],
			name: "messages_conversation_id_conversations_id_fk"
		}).onDelete("cascade"),
]);

export const invitesInChat = chat.table("invites", {
	id: text().primaryKey().notNull(),
	conversationId: text("conversation_id").notNull(),
	createdBy: text("created_by").notNull(),
	forDid: text("for_did"),
	maxUses: text("max_uses"),
	usedCount: text("used_count").default('0').notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_chat_invites_conversation").using("btree", table.conversationId.asc().nullsLast().op("text_ops")),
	index("idx_chat_invites_for_did").using("btree", table.forDid.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversationsInChat.id],
			name: "invites_conversation_id_conversations_id_fk"
		}).onDelete("cascade"),
]);

export const publicKeysInChat = chat.table("public_keys", {
	did: text().primaryKey().notNull(),
	identityKey: text("identity_key").notNull(),
	signedPreKey: text("signed_pre_key").notNull(),
	signature: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const preKeysInChat = chat.table("pre_keys", {
	id: text().primaryKey().notNull(),
	did: text().notNull(),
	key: text().notNull(),
	used: boolean().default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_chat_pre_keys_did").using("btree", table.did.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.did],
			foreignColumns: [publicKeysInChat.did],
			name: "pre_keys_did_public_keys_did_fk"
		}).onDelete("cascade"),
]);

export const conversationReadsInChat = chat.table("conversation_reads", {
	conversationId: text("conversation_id").notNull(),
	did: text().notNull(),
	lastReadAt: timestamp("last_read_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversationsInChat.id],
			name: "conversation_reads_conversation_id_conversations_id_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.conversationId, table.did], name: "conversation_reads_conversation_id_did_pk"}),
]);

export const readReceiptsInChat = chat.table("read_receipts", {
	conversationId: text("conversation_id").notNull(),
	did: text().notNull(),
	lastReadMessageId: text("last_read_message_id"),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversationsInChat.id],
			name: "read_receipts_conversation_id_conversations_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lastReadMessageId],
			foreignColumns: [messagesInChat.id],
			name: "read_receipts_last_read_message_id_messages_id_fk"
		}),
	primaryKey({ columns: [table.conversationId, table.did], name: "read_receipts_conversation_id_did_pk"}),
]);

export const messageReactionsInChat = chat.table("message_reactions", {
	messageId: text("message_id").notNull(),
	did: text().notNull(),
	emoji: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_chat_message_reactions_message").using("btree", table.messageId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messagesInChat.id],
			name: "message_reactions_message_id_messages_id_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.messageId, table.did, table.emoji], name: "message_reactions_message_id_did_emoji_pk"}),
]);

export const participantsInChat = chat.table("participants", {
	conversationId: text("conversation_id").notNull(),
	did: text().notNull(),
	role: text().default('member').notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	invitedBy: text("invited_by"),
	lastReadAt: timestamp("last_read_at", { withTimezone: true, mode: 'string' }),
	muted: boolean().default(false),
	trustExtendedTo: jsonb("trust_extended_to").default([]),
}, (table) => [
	index("idx_chat_participants_did").using("btree", table.did.asc().nullsLast().op("text_ops")),
	index("idx_chat_participants_role").using("btree", table.role.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversationsInChat.id],
			name: "participants_conversation_id_conversations_id_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.conversationId, table.did], name: "participants_conversation_id_did_pk"}),
]);
