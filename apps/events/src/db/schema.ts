import { pgTable, text, timestamp, jsonb, integer, boolean, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Events - happenings on the network
 */
export const events = pgTable('events', {
  id: text('id').primaryKey(),                              // evt_xxx
  did: text('did').notNull().unique(),                      // did:imajin:xxx (event's own DID)
  publicKey: text('public_key').notNull(),                  // Ed25519 public key for signing tickets
  privateKey: text('private_key'),                           // Ed25519 private key for signing tickets (hex)
  creatorDid: text('creator_did').notNull(),                // DID of creator
  title: text('title').notNull(),
  description: text('description'),
  
  // Timing
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  
  // Location
  isVirtual: boolean('is_virtual').default(false),
  virtualUrl: text('virtual_url'),
  venue: text('venue'),
  address: text('address'),
  city: text('city'),
  country: text('country'),
  
  // Status
  status: text('status').notNull().default('draft'),        // draft, published, cancelled, completed
  
  // Media
  imageUrl: text('image_url'),
  
  // Metadata
  tags: jsonb('tags').default([]),
  metadata: jsonb('metadata').default({}),

  // Trust pod integration
  podId: text('pod_id'),                                    // Links to trust_pods.id
  lobbyConversationId: text('lobby_conversation_id'),       // Event lobby chat (open to ticket holders)

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  creatorIdx: index('idx_events_creator').on(table.creatorDid),
  statusIdx: index('idx_events_status').on(table.status),
  startsIdx: index('idx_events_starts').on(table.startsAt),
  podIdx: index('idx_events_pod_id').on(table.podId),
}));

/**
 * Ticket Types - different tiers for an event
 */
export const ticketTypes = pgTable('ticket_types', {
  id: text('id').primaryKey(),                              // tkt_type_xxx
  eventId: text('event_id').references(() => events.id).notNull(),
  name: text('name').notNull(),                             // "Virtual", "Physical", "VIP"
  description: text('description'),
  price: integer('price').notNull(),                        // in cents
  currency: text('currency').notNull().default('USD'),
  quantity: integer('quantity'),                            // null = unlimited
  sold: integer('sold').default(0),
  
  // Perks/metadata
  perks: jsonb('perks').default([]),
  metadata: jsonb('metadata').default({}),
  
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  eventIdx: index('idx_ticket_types_event').on(table.eventId),
}));

/**
 * Event Admins - co-hosts with management permissions
 */
export const eventAdmins = pgTable('event_admins', {
  eventId: text('event_id').references(() => events.id, { onDelete: 'cascade' }).notNull(),
  did: text('did').notNull(),
  role: text('role').notNull().default('admin'),            // owner | admin
  addedBy: text('added_by').notNull(),                      // DID who added them
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.eventId, table.did] }),
  eventIdx: index('idx_event_admins_event').on(table.eventId),
  didIdx: index('idx_event_admins_did').on(table.did),
}));

/**
 * Tickets - purchased tickets owned by DIDs
 */
export const tickets = pgTable('tickets', {
  id: text('id').primaryKey(),                              // tkt_xxx
  eventId: text('event_id').references(() => events.id).notNull(),
  ticketTypeId: text('ticket_type_id').references(() => ticketTypes.id).notNull(),
  ownerDid: text('owner_did'),                              // Current owner (null if held/available)
  originalOwnerDid: text('original_owner_did'),             // First purchaser
  
  // Purchase info
  purchasedAt: timestamp('purchased_at', { withTimezone: true }),
  pricePaid: integer('price_paid'),
  currency: text('currency'),
  paymentId: text('payment_id'),                            // Reference to pay service
  
  // Status: available, held, sold, used, cancelled
  status: text('status').notNull().default('available'),
  
  // Hold info
  heldBy: text('held_by'),                                  // DID holding the ticket
  heldUntil: timestamp('held_until', { withTimezone: true }),
  
  // Usage
  usedAt: timestamp('used_at', { withTimezone: true }),
  
  // Signature (event signs ticket issuance)
  signature: text('signature'),
  
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  eventIdx: index('idx_tickets_event').on(table.eventId),
  ownerIdx: index('idx_tickets_owner').on(table.ownerDid),
  statusIdx: index('idx_tickets_status').on(table.status),
  heldByIdx: index('idx_tickets_held_by').on(table.heldBy),
}));

/**
 * Ticket Transfers - transparent chain of custody
 */
export const ticketTransfers = pgTable('ticket_transfers', {
  id: text('id').primaryKey(),                              // xfer_xxx
  ticketId: text('ticket_id').references(() => tickets.id).notNull(),
  fromDid: text('from_did').notNull(),
  toDid: text('to_did').notNull(),
  transferredAt: timestamp('transferred_at', { withTimezone: true }).defaultNow(),
  signature: text('signature').notNull(),                   // From sender, proves consent
}, (table) => ({
  ticketIdx: index('idx_ticket_transfers_ticket').on(table.ticketId),
  fromIdx: index('idx_ticket_transfers_from').on(table.fromDid),
  toIdx: index('idx_ticket_transfers_to').on(table.toDid),
}));

/**
 * Ticket Queue - waiting list for high-demand events
 */
export const ticketQueue = pgTable('ticket_queue', {
  id: text('id').primaryKey(),                              // q_xxx
  ticketTypeId: text('ticket_type_id').references(() => ticketTypes.id).notNull(),
  did: text('did').notNull(),
  position: integer('position').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }), // Window to purchase after notification
  status: text('status').notNull().default('waiting'),      // waiting, notified, purchased, expired
}, (table) => ({
  typeIdx: index('idx_ticket_queue_type').on(table.ticketTypeId),
  didIdx: index('idx_ticket_queue_did').on(table.did),
  positionIdx: index('idx_ticket_queue_position').on(table.position),
  statusIdx: index('idx_ticket_queue_status').on(table.status),
}));

// Types
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventAdmin = typeof eventAdmins.$inferSelect;
export type TicketType = typeof ticketTypes.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type TicketTransfer = typeof ticketTransfers.$inferSelect;
export type TicketQueueEntry = typeof ticketQueue.$inferSelect;
