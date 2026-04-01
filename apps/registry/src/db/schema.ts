import { pgTable, text, timestamp, jsonb, index, boolean, pgSchema, unique } from 'drizzle-orm/pg-core';

export const registrySchema = pgSchema('registry');

/**
 * Registered nodes in the network
 */
export const nodes = registrySchema.table('nodes', {
  // Identity
  id: text('id').primaryKey(),                        // did:imajin:xxx
  publicKey: text('public_key').notNull().unique(),   // Ed25519 hex
  
  // Network presence
  hostname: text('hostname').notNull().unique(),      // "jin"
  subdomain: text('subdomain').notNull().unique(),    // "jin.imajin.ai"
  services: jsonb('services').default([]),            // ["auth", "pay"]
  capabilities: jsonb('capabilities').default([]),    // What node offers
  
  // Status
  status: text('status').notNull().default('pending'), // pending|active|stale|unreachable|expired|revoked
  
  // Build info
  buildHash: text('build_hash').notNull(),            // SHA256 of running build
  version: text('version').notNull(),                 // Semantic version
  sourceCommit: text('source_commit'),                // Git SHA (optional)
  
  // Timestamps
  lastHeartbeat: timestamp('last_heartbeat', { withTimezone: true }),
  registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  
  // Chain identity (optional — only set if node registered with chain log)
  chainDid: text('chain_did').unique(),               // did:dfos:... (chain-native DID)

  // Full attestation record
  attestation: jsonb('attestation').notNull(),
  
  // Metadata
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  statusIdx: index('idx_registry_nodes_status').on(table.status),
  expiresIdx: index('idx_registry_nodes_expires').on(table.expiresAt),
  hostnameIdx: index('idx_registry_nodes_hostname').on(table.hostname),
}));

/**
 * Approved build hashes for each version
 */
export const approvedBuilds = registrySchema.table('approved_builds', {
  id: text('id').primaryKey(),                        // uuid
  version: text('version').notNull(),                 // "0.1.0"
  buildHash: text('build_hash').notNull().unique(),   // SHA256
  architecture: text('architecture'),                 // "linux-x64", "darwin-arm64"
  releaseDate: timestamp('release_date', { withTimezone: true }).defaultNow(),
  deprecated: boolean('deprecated').default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  versionIdx: index('idx_registry_builds_version').on(table.version),
  hashIdx: index('idx_registry_builds_hash').on(table.buildHash),
}));

/**
 * Heartbeat history (optional, for analytics)
 */
export const heartbeats = registrySchema.table('heartbeats', {
  id: text('id').primaryKey(),                        // uuid
  nodeId: text('node_id').references(() => nodes.id).notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow(),
  buildHash: text('build_hash').notNull(),
  version: text('version').notNull(),
  health: jsonb('health'),                            // { status, services, uptime, metrics }
  signature: text('signature').notNull(),
}, (table) => ({
  nodeIdx: index('idx_registry_heartbeats_node').on(table.nodeId),
  timestampIdx: index('idx_registry_heartbeats_timestamp').on(table.timestamp),
}));

/**
 * Mesh trust relationships (synced from nodes)
 */
export const trustRelationships = registrySchema.table('trust', {
  id: text('id').primaryKey(),                        // uuid
  fromNode: text('from_node').references(() => nodes.id).notNull(),
  toNode: text('to_node').references(() => nodes.id).notNull(),
  establishedAt: timestamp('established_at', { withTimezone: true }).notNull(),
  verificationMethod: text('verification_method').notNull(), // optical|network|manual
  strength: text('strength').notNull(),               // 0.0-1.0 as string
  lastVerified: timestamp('last_verified', { withTimezone: true }),
  fromSignature: text('from_signature').notNull(),
  toSignature: text('to_signature').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  fromIdx: index('idx_registry_trust_from').on(table.fromNode),
  toIdx: index('idx_registry_trust_to').on(table.toNode),
}));

/**
 * Interest metadata — declared by apps during registration
 */
export const interests = registrySchema.table('interests', {
  id: text('id').primaryKey(),                           // int_<nanoid>
  scope: text('scope').notNull().unique(),               // 'events', 'market', 'coffee'
  label: text('label').notNull(),                        // 'Events & Gatherings'
  description: text('description'),                      // shown on preferences page
  triggers: jsonb('triggers').default([]),               // ['ticket.purchased', 'event.created']
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Global DID preferences
 */
export const didPreferences = registrySchema.table('did_preferences', {
  did: text('did').primaryKey(),
  globalMarketing: boolean('global_marketing').default(true),
  autoSubscribe: boolean('auto_subscribe').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Per-scope interests — created lazily from attestation activity
 */
export const didInterests = registrySchema.table('did_interests', {
  id: text('id').primaryKey(),                           // din_<nanoid>
  did: text('did').notNull(),
  scope: text('scope').notNull(),                        // references interests.scope
  marketing: boolean('marketing').default(true),         // receive marketing for this scope?
  email: boolean('email').default(true),                 // email channel
  inapp: boolean('inapp').default(true),                 // in-app channel
  chat: boolean('chat').default(true),                   // chat DM channel
  createdByAttestation: text('created_by_attestation'),  // e.g. 'ticket.purchased'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_did_interests_did').on(table.did),
  scopeIdx: index('idx_did_interests_scope').on(table.scope),
  didScopeUnique: unique('uniq_did_interests_did_scope').on(table.did, table.scope),
}));

// Types
export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type ApprovedBuild = typeof approvedBuilds.$inferSelect;
export type Heartbeat = typeof heartbeats.$inferSelect;
export type TrustRelationship = typeof trustRelationships.$inferSelect;
export type Interest = typeof interests.$inferSelect;
export type NewInterest = typeof interests.$inferInsert;
export type DidPreference = typeof didPreferences.$inferSelect;
export type DidInterest = typeof didInterests.$inferSelect;
