import { pgTable, pgSchema, index, foreignKey, text, integer, timestamp, unique, jsonb, boolean, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const events = pgSchema("events");


export const ticketQueueInEvents = events.table("ticket_queue", {
	id: text().primaryKey().notNull(),
	ticketTypeId: text("ticket_type_id").notNull(),
	did: text().notNull(),
	position: integer().notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	notifiedAt: timestamp("notified_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	status: text().default('waiting').notNull(),
}, (table) => [
	index("idx_ticket_queue_did").using("btree", table.did.asc().nullsLast().op("text_ops")),
	index("idx_ticket_queue_position").using("btree", table.position.asc().nullsLast().op("int4_ops")),
	index("idx_ticket_queue_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_ticket_queue_type").using("btree", table.ticketTypeId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.ticketTypeId],
			foreignColumns: [ticketTypesInEvents.id],
			name: "ticket_queue_ticket_type_id_ticket_types_id_fk"
		}),
]);

export const ticketsInEvents = events.table("tickets", {
	id: text().primaryKey().notNull(),
	eventId: text("event_id").notNull(),
	ticketTypeId: text("ticket_type_id").notNull(),
	ownerDid: text("owner_did"),
	originalOwnerDid: text("original_owner_did"),
	purchasedAt: timestamp("purchased_at", { withTimezone: true, mode: 'string' }),
	pricePaid: integer("price_paid"),
	currency: text(),
	paymentId: text("payment_id"),
	status: text().default('available').notNull(),
	heldBy: text("held_by"),
	heldUntil: timestamp("held_until", { withTimezone: true, mode: 'string' }),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	signature: text(),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	magicToken: text("magic_token"),
	paymentMethod: text("payment_method").default('stripe'),
	holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true, mode: 'string' }),
	paymentConfirmedAt: timestamp("payment_confirmed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_tickets_event").using("btree", table.eventId.asc().nullsLast().op("text_ops")),
	index("idx_tickets_held_by").using("btree", table.heldBy.asc().nullsLast().op("text_ops")),
	index("idx_tickets_magic_token").using("btree", table.magicToken.asc().nullsLast().op("text_ops")),
	index("idx_tickets_owner").using("btree", table.ownerDid.asc().nullsLast().op("text_ops")),
	index("idx_tickets_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [eventsInEvents.id],
			name: "tickets_event_id_events_id_fk"
		}),
	foreignKey({
			columns: [table.ticketTypeId],
			foreignColumns: [ticketTypesInEvents.id],
			name: "tickets_ticket_type_id_ticket_types_id_fk"
		}),
	unique("tickets_magic_token_unique").on(table.magicToken),
]);

export const ticketTransfersInEvents = events.table("ticket_transfers", {
	id: text().primaryKey().notNull(),
	ticketId: text("ticket_id").notNull(),
	fromDid: text("from_did").notNull(),
	toDid: text("to_did").notNull(),
	transferredAt: timestamp("transferred_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	signature: text().notNull(),
}, (table) => [
	index("idx_ticket_transfers_from").using("btree", table.fromDid.asc().nullsLast().op("text_ops")),
	index("idx_ticket_transfers_ticket").using("btree", table.ticketId.asc().nullsLast().op("text_ops")),
	index("idx_ticket_transfers_to").using("btree", table.toDid.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.ticketId],
			foreignColumns: [ticketsInEvents.id],
			name: "ticket_transfers_ticket_id_tickets_id_fk"
		}),
]);

export const ticketTypesInEvents = events.table("ticket_types", {
	id: text().primaryKey().notNull(),
	eventId: text("event_id").notNull(),
	name: text().notNull(),
	description: text(),
	price: integer().notNull(),
	currency: text().default('USD').notNull(),
	quantity: integer(),
	sold: integer().default(0),
	perks: jsonb().default([]),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	sortOrder: integer("sort_order").default(0).notNull(),
	requiresRegistration: boolean("requires_registration").default(false),
	registrationFormId: text("registration_form_id"),
	maxPerOrder: integer("max_per_order"),
}, (table) => [
	index("idx_ticket_types_event").using("btree", table.eventId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [eventsInEvents.id],
			name: "ticket_types_event_id_events_id_fk"
		}),
]);

export const eventsInEvents = events.table("events", {
	id: text().primaryKey().notNull(),
	did: text().notNull(),
	publicKey: text("public_key").notNull(),
	creatorDid: text("creator_did").notNull(),
	title: text().notNull(),
	description: text(),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }).notNull(),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'string' }),
	isVirtual: boolean("is_virtual").default(false),
	virtualUrl: text("virtual_url"),
	venue: text(),
	address: text(),
	city: text(),
	country: text(),
	status: text().default('draft').notNull(),
	imageUrl: text("image_url"),
	tags: jsonb().default([]),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	podId: text("pod_id"),
	privateKey: text("private_key"),
	lobbyConversationId: text("lobby_conversation_id"),
	accessMode: text("access_mode").default('public').notNull(),
	nameDisplayPolicy: text("name_display_policy").default('attendee_choice').notNull(),
	timezone: text(),
	courseSlug: text("course_slug"),
}, (table) => [
	index("idx_events_course_slug").using("btree", table.courseSlug.asc().nullsLast().op("text_ops")),
	index("idx_events_creator").using("btree", table.creatorDid.asc().nullsLast().op("text_ops")),
	index("idx_events_pod_id").using("btree", table.podId.asc().nullsLast().op("text_ops")),
	index("idx_events_starts").using("btree", table.startsAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_events_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	unique("events_did_unique").on(table.did),
]);

export const eventInvitesInEvents = events.table("event_invites", {
	id: text().primaryKey().notNull(),
	eventId: text("event_id").notNull(),
	token: text().notNull(),
	label: text(),
	maxUses: integer("max_uses"),
	usedCount: integer("used_count").default(0).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [eventsInEvents.id],
			name: "event_invites_event_id_fkey"
		}),
	unique("event_invites_token_key").on(table.token),
]);

