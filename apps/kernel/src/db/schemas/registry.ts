import { pgTable, text, timestamp, jsonb, index, boolean, pgSchema, unique, real, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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

  // Chain identity (optional)
  chainDid: text('chain_did').unique(),               // did:dfos:...

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
  description: text('description'),
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
  marketing: boolean('marketing').default(true),
  email: boolean('email').default(true),
  inapp: boolean('inapp').default(true),
  chat: boolean('chat').default(true),
  createdByAttestation: text('created_by_attestation'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_did_interests_did').on(table.did),
  scopeIdx: index('idx_did_interests_scope').on(table.scope),
  didScopeUnique: unique('uniq_did_interests_did_scope').on(table.did, table.scope),
}));

/**
 * Bump sessions — active pairing windows per DID per node
 */
export const bumpSessions = registrySchema.table('bump_sessions', {
  id: text('id').primaryKey(),
  did: text('did').notNull(),
  nodeId: text('node_id').notNull(),
  location: jsonb('location'),                                   // { lat, lng }
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
}, (table) => ({
  nodeExpiresIdx: index('idx_bump_sessions_node_expires').on(table.nodeId, table.expiresAt).where(sql`deactivated_at IS NULL`),
}));

/**
 * Bump events — accelerometer/gyro samples from active sessions
 */
export const bumpEvents = registrySchema.table('bump_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').references(() => bumpSessions.id).notNull(),
  waveform: jsonb('waveform').notNull(),                         // number[]
  rotationRate: jsonb('rotation_rate').notNull(),                // number[]
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  location: jsonb('location'),                                   // { lat, lng }
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  sessionCreatedIdx: index('idx_bump_events_session_created').on(table.sessionId, table.createdAt),
}));

/**
 * Bump matches — correlation results between two sessions
 */
export const bumpMatches = registrySchema.table('bump_matches', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  sessionA: text('session_a').references(() => bumpSessions.id).notNull(),
  sessionB: text('session_b').references(() => bumpSessions.id).notNull(),
  correlationScore: real('correlation_score').notNull(),
  confirmedA: boolean('confirmed_a'),
  confirmedB: boolean('confirmed_b'),
  connectionId: text('connection_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  expiresNoConnectionIdx: index('idx_bump_matches_expires_no_connection').on(table.expiresAt).where(sql`connection_id IS NULL`),
}));

/**
 * Newsletter sends — records of outbound newsletter/broadcast emails
 */
export const newsletterSends = registrySchema.table('newsletter_sends', {
  id: text('id').primaryKey(),
  senderDid: text('sender_did').notNull(),
  subject: text('subject').notNull(),
  audienceType: text('audience_type').notNull(), // 'newsletter' | 'connections'
  audienceId: text('audience_id'), // mailing list id or null for connections
  recipientCount: integer('recipient_count').notNull().default(0),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow(),
});

/**
 * Node configuration key-value store
 */
export const nodeConfig = registrySchema.table('node_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type NodeConfig = typeof nodeConfig.$inferSelect;

/**
 * Content/identity flags submitted by users
 */
export const flags = registrySchema.table('flags', {
  id: text('id').primaryKey(),
  reporterDid: text('reporter_did').notNull(),
  targetDid: text('target_did').notNull(),
  targetType: text('target_type').notNull(), // 'identity' | 'asset' | 'listing' | 'event' | 'message'
  targetId: text('target_id').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'dismissed' | 'actioned'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by'),
  resolution: text('resolution'),
});

export type Flag = typeof flags.$inferSelect;

/**
 * Audit log of moderation actions
 */
export const moderationLog = registrySchema.table('moderation_log', {
  id: text('id').primaryKey(),
  operatorDid: text('operator_did').notNull(),
  action: text('action').notNull(), // 'suspend' | 'unsuspend' | 'warn' | 'remove_content' | 'dismiss_flag' | 'ban'
  targetDid: text('target_did').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type ModerationLog = typeof moderationLog.$inferSelect;

/**
 * System events — fire-and-forget audit log written by @imajin/events
 */
export const systemEvents = registrySchema.table('system_events', {
  id: text('id').primaryKey(),
  service: text('service').notNull(),
  action: text('action').notNull(),
  did: text('did'),
  correlationId: text('correlation_id'),
  parentEventId: text('parent_event_id'),
  payload: jsonb('payload'),
  status: text('status').default('success'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  serviceActionIdx: index('idx_system_events_service_action').on(table.service, table.action),
  correlationIdx: index('idx_system_events_correlation').on(table.correlationId),
  didIdx: index('idx_system_events_did').on(table.did),
  createdIdx: index('idx_system_events_created').on(table.createdAt),
}));

export type SystemEvent = typeof systemEvents.$inferSelect;

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
export type BumpSession = typeof bumpSessions.$inferSelect;
export type NewBumpSession = typeof bumpSessions.$inferInsert;
export type BumpEvent = typeof bumpEvents.$inferSelect;
export type BumpMatch = typeof bumpMatches.$inferSelect;
