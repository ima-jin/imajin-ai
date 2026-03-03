import { pgTable, text, timestamp, jsonb, index, real } from 'drizzle-orm/pg-core';

/**
 * Profiles - public identity pages linked to DIDs
 */
export const profiles = pgTable('profiles', {
  did: text('did').primaryKey(),                              // did:imajin:xxx
  handle: text('handle').unique(),                            // unique handle (e.g., "jin", "ryan")
  displayName: text('display_name').notNull(),
  displayType: text('display_type').notNull(),                // 'human' | 'agent' | 'device' | 'org' | 'event' | 'service'
  avatar: text('avatar'),                                     // URL or emoji
  bio: text('bio'),
  email: text('email'),                                       // contact email (plaintext for now)
  phone: text('phone'),                                       // contact phone (plaintext for now)
  // invitedBy moved to connections service
  identityTier: text('identity_tier').notNull().default('soft'), // 'soft' | 'hard'
  nextInviteAvailableAt: timestamp('next_invite_available_at', { withTimezone: true }), // NULL = can invite now
  metadata: jsonb('metadata').default({}),                    // location, website, etc.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }), // Online presence tracking
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  handleIdx: index('idx_profiles_handle').on(table.handle),
  displayTypeIdx: index('idx_profiles_display_type').on(table.displayType),
}));

/**
 * Connections - trust relationships between entities
 * Replaces invitedBy with a proper graph structure
 */
export const connections = pgTable('connections', {
  id: text('id').primaryKey(),                                // conn_xxx
  fromDid: text('from_did').notNull(),                        // Who created the connection
  toDid: text('to_did').notNull(),                            // Who they're connected to
  
  // Trust level: 0 = encountered but no trust, 1 = full trust
  trustLevel: real('trust_level').notNull().default(0),
  
  // How the connection was formed
  source: text('source').notNull(),                           // 'direct' | 'event' | 'group' | 'invite'
  sourceId: text('source_id'),                                // Event ID, group ID, etc.
  
  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  fromDidIdx: index('idx_connections_from').on(table.fromDid),
  toDidIdx: index('idx_connections_to').on(table.toDid),
  sourceIdx: index('idx_connections_source').on(table.source, table.sourceId),
}));

/**
 * Connection requests - pending trust requests
 */
export const connectionRequests = pgTable('connection_requests', {
  id: text('id').primaryKey(),                                // req_xxx
  fromDid: text('from_did').notNull(),
  toDid: text('to_did').notNull(),
  message: text('message'),                                   // Optional message
  status: text('status').notNull().default('pending'),        // 'pending' | 'accepted' | 'rejected'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
}, (table) => ({
  fromDidIdx: index('idx_conn_requests_from').on(table.fromDid),
  toDidIdx: index('idx_conn_requests_to').on(table.toDid),
  statusIdx: index('idx_conn_requests_status').on(table.status),
}));

/**
 * DID migrations - track when soft DIDs upgrade to hard DIDs
 */
export const didMigrations = pgTable('did_migrations', {
  id: text('id').primaryKey(),                                // migration_xxx
  oldDid: text('old_did').notNull(),                          // did:email:xxx (soft)
  newDid: text('new_did').notNull(),                          // did:imajin:xxx (hard)
  migratedAt: timestamp('migrated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  oldDidIdx: index('idx_did_migrations_old').on(table.oldDid),
  newDidIdx: index('idx_did_migrations_new').on(table.newDid),
}));

// Types
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type ConnectionRequest = typeof connectionRequests.$inferSelect;
export type NewConnectionRequest = typeof connectionRequests.$inferInsert;
export type DidMigration = typeof didMigrations.$inferSelect;
export type NewDidMigration = typeof didMigrations.$inferInsert;
