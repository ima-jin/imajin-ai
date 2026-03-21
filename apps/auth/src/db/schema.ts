import { pgTable, text, timestamp, jsonb, integer, boolean, index, uniqueIndex, pgSchema } from 'drizzle-orm/pg-core';

export const authSchema = pgSchema('auth');

/**
 * Identities - humans and agents with public keys
 */
export const identities = authSchema.table('identities', {
  id: text('id').primaryKey(),                    // did:imajin:xxx
  type: text('type').notNull(),                   // 'human' | 'agent'
  publicKey: text('public_key').notNull().unique(),
  handle: text('handle').unique(),                // @username (unique, optional)
  name: text('name'),                             // Display name
  avatarUrl: text('avatar_url'),
  tier: text('tier').notNull().default('soft'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  handleIdx: index('idx_auth_identities_handle').on(table.handle),
}));

/**
 * Challenges - short-lived, for authentication flow
 */
export const challenges = authSchema.table('challenges', {
  id: text('id').primaryKey(),
  identityId: text('identity_id').references(() => identities.id),
  challenge: text('challenge').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  expiresIdx: index('idx_auth_challenges_expires').on(table.expiresAt),
}));

/**
 * Tokens - issued after successful authentication
 */
export const tokens = authSchema.table('tokens', {
  id: text('id').primaryKey(),                    // imajin_tok_xxx
  identityId: text('identity_id').references(() => identities.id).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => ({
  identityIdx: index('idx_auth_tokens_identity').on(table.identityId),
}));

/**
 * Onboard Tokens - email verification for anonymous → soft DID onboarding
 *
 * Used by @imajin/onboard to verify email before minting soft DID.
 * 15 minute TTL, single use.
 */
export const onboardTokens = authSchema.table('onboard_tokens', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  token: text('token').notNull().unique(),
  redirectUrl: text('redirect_url'),
  context: text('context'),                       // Human-readable: "Enroll in Intro to AI"
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tokenIdx: index('idx_auth_onboard_tokens_token').on(table.token),
  emailIdx: index('idx_auth_onboard_tokens_email').on(table.email),
}));

/**
 * Attestations - signed claims about identities
 *
 * Issued by one DID (issuer) about another DID (subject).
 * Signature covers canonicalized: { subject_did, type, context_id, context_type, payload, issued_at }
 */
export const attestations = authSchema.table('attestations', {
  id: text('id').primaryKey(),                         // att_xxx
  issuerDid: text('issuer_did').notNull(),
  subjectDid: text('subject_did').notNull(),
  type: text('type').notNull(),                        // AttestationType
  contextId: text('context_id'),                       // e.g. event DID
  contextType: text('context_type'),                   // e.g. 'event'
  payload: jsonb('payload'),
  signature: text('signature').notNull(),              // Ed25519 hex (128 chars)
  issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  subjectIdx: index('idx_auth_attestations_subject').on(table.subjectDid),
  issuerIdx: index('idx_auth_attestations_issuer').on(table.issuerDid),
  typeIdx: index('idx_auth_attestations_type').on(table.type),
}));

/**
 * Credentials - authentication methods linked to identities
 *
 * Decouples identity (DID) from auth method (email, keypair, etc.)
 * so that a single DID can have multiple credentials and can
 * graduate from email to keypair without changing identity.
 */
export const credentials = authSchema.table('credentials', {
  id: text('id').primaryKey(),                    // cred_xxx
  did: text('did').notNull(),                     // references auth.identities
  type: text('type').notNull(),                   // 'email' | 'keypair'
  value: text('value').notNull(),                 // email address, public key, etc.
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_credentials_did').on(table.did),
  typeValueIdx: uniqueIndex('idx_credentials_type_value').on(table.type, table.value),
}));

/**
 * Identity Chains — DFOS proof chains for self-certifying identity
 *
 * Each identity with a real Ed25519 key gets a DFOS identity chain.
 * The chain is append-only: genesis (create), then updates (rotate, delete).
 * The log array contains JWS tokens verifiable by anyone with
 * @metalabel/dfos-protocol — no server needed.
 */
export const identityChains = authSchema.table('identity_chains', {
  did: text('did').primaryKey().references(() => identities.id),
  dfosDid: text('dfos_did').notNull().unique(),
  log: jsonb('log').notNull().$type<string[]>(),
  headCid: text('head_cid').notNull(),
  keyCount: integer('key_count').notNull().default(1),
  isDeleted: boolean('is_deleted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  dfosDidIdx: uniqueIndex('idx_identity_chains_dfos_did').on(table.dfosDid),
}));

export type IdentityChain = typeof identityChains.$inferSelect;
export type NewIdentityChain = typeof identityChains.$inferInsert;

// Types
export type Identity = typeof identities.$inferSelect;
export type NewIdentity = typeof identities.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type OnboardToken = typeof onboardTokens.$inferSelect;
export type Attestation = typeof attestations.$inferSelect;
export type NewAttestation = typeof attestations.$inferInsert;
export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
