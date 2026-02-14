import { pgTable, text, timestamp, jsonb, index, boolean } from 'drizzle-orm/pg-core';

/**
 * Registered nodes in the network
 */
export const nodes = pgTable('registry_nodes', {
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
export const approvedBuilds = pgTable('registry_approved_builds', {
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
export const heartbeats = pgTable('registry_heartbeats', {
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
export const trustRelationships = pgTable('registry_trust', {
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

// Types
export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type ApprovedBuild = typeof approvedBuilds.$inferSelect;
export type Heartbeat = typeof heartbeats.$inferSelect;
export type TrustRelationship = typeof trustRelationships.$inferSelect;
