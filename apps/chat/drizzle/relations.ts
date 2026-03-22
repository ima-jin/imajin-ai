import { relations } from "drizzle-orm/relations";
import { conversationsInChat, messagesInChat, invitesInChat, publicKeysInChat, preKeysInChat, conversationReadsInChat, readReceiptsInChat, messageReactionsInChat, participantsInChat } from "./schema";

export const messagesInChatRelations = relations(messagesInChat, ({one, many}) => ({
	conversationsInChat: one(conversationsInChat, {
		fields: [messagesInChat.conversationId],
		references: [conversationsInChat.id]
	}),
	readReceiptsInChats: many(readReceiptsInChat),
	messageReactionsInChats: many(messageReactionsInChat),
}));

export const conversationsInChatRelations = relations(conversationsInChat, ({many}) => ({
	messagesInChats: many(messagesInChat),
	invitesInChats: many(invitesInChat),
	conversationReadsInChats: many(conversationReadsInChat),
	readReceiptsInChats: many(readReceiptsInChat),
	participantsInChats: many(participantsInChat),
}));

export const invitesInChatRelations = relations(invitesInChat, ({one}) => ({
	conversationsInChat: one(conversationsInChat, {
		fields: [invitesInChat.conversationId],
		references: [conversationsInChat.id]
	}),
}));

export const preKeysInChatRelations = relations(preKeysInChat, ({one}) => ({
	publicKeysInChat: one(publicKeysInChat, {
		fields: [preKeysInChat.did],
		references: [publicKeysInChat.did]
	}),
}));

export const publicKeysInChatRelations = relations(publicKeysInChat, ({many}) => ({
	preKeysInChats: many(preKeysInChat),
}));

export const conversationReadsInChatRelations = relations(conversationReadsInChat, ({one}) => ({
	conversationsInChat: one(conversationsInChat, {
		fields: [conversationReadsInChat.conversationId],
		references: [conversationsInChat.id]
	}),
}));

export const readReceiptsInChatRelations = relations(readReceiptsInChat, ({one}) => ({
	conversationsInChat: one(conversationsInChat, {
		fields: [readReceiptsInChat.conversationId],
		references: [conversationsInChat.id]
	}),
	messagesInChat: one(messagesInChat, {
		fields: [readReceiptsInChat.lastReadMessageId],
		references: [messagesInChat.id]
	}),
}));

export const messageReactionsInChatRelations = relations(messageReactionsInChat, ({one}) => ({
	messagesInChat: one(messagesInChat, {
		fields: [messageReactionsInChat.messageId],
		references: [messagesInChat.id]
	}),
}));

export const participantsInChatRelations = relations(participantsInChat, ({one}) => ({
	conversationsInChat: one(conversationsInChat, {
		fields: [participantsInChat.conversationId],
		references: [conversationsInChat.id]
	}),
}));