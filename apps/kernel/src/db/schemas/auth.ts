import { pgTable, text, timestamp, jsonb, integer, boolean, index, uniqueIndex, pgSchema } from 'drizzle-orm/pg-core';

/** Key role configuration for multi-device / role-separated identities */
export interface KeyRoles {
  auth: string[];       // multibase public keys for authentication
  assert: string[];     // multibase public keys for signing content
  controller: string[]; // multibase public keys for rotation/deletion
}

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
  avatarAssetId: text('avatar_asset_id'),           // asset_xxx from media service
  tier: text('tier').notNull().default('soft'),
  handleClaimedAt: timestamp('handle_claimed_at', { withTimezone: true }),
  contactEmail: text('contact_email'),                  // billing/notification email from Stripe or onboard
  keyRoles: jsonb('key_roles').$type<KeyRoles | null>(), // null = single key in all roles
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
  keyId: text('key_id'),                          // which key created this session
  keyRole: text('key_role'),                      // 'auth' | 'assert' | 'controller'
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => ({
  identityIdx: index('idx_auth_tokens_identity').on(table.identityId),
}));

/**
 * Onboard Tokens - email verification for anonymous → soft DID onboarding
 */
export const onboardTokens = authSchema.table('onboard_tokens', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  token: text('token').notNull().unique(),
  redirectUrl: text('redirect_url'),
  context: text('context'),                       // Human-readable: "Enroll in Intro to AI"
  scopeDid: text('scope_did'),                    // Forest DID to join on completion
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tokenIdx: index('idx_auth_onboard_tokens_token').on(table.token),
  emailIdx: index('idx_auth_onboard_tokens_email').on(table.email),
}));

/**
 * Attestations - signed claims about identities
 */
export const attestations = authSchema.table('attestations', {
  id: text('id').primaryKey(),                         // att_xxx
  issuerDid: text('issuer_did').notNull(),
  subjectDid: text('subject_did').notNull(),
  type: text('type').notNull(),                        // AttestationType
  contextId: text('context_id'),                       // e.g. event DID
  contextType: text('context_type'),                   // e.g. 'event'
  payload: jsonb('payload'),
  signature: text('signature').notNull(),              // Ed25519 hex (128 chars) — legacy
  cid: text('cid'),                                    // dag-cbor CID of attestation payload
  authorJws: text('author_jws'),                       // JWS compact token (author signature)
  witnessJws: text('witness_jws'),                     // JWS compact token (countersignature)
  attestationStatus: text('attestation_status').default('pending'), // 'pending' | 'bilateral' | 'declined'
  issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  subjectIdx: index('idx_auth_attestations_subject').on(table.subjectDid),
  issuerIdx: index('idx_auth_attestations_issuer').on(table.issuerDid),
  typeIdx: index('idx_auth_attestations_type').on(table.type),
  statusIdx: index('idx_auth_attestations_status').on(table.attestationStatus),
}));

/**
 * Credentials - authentication methods linked to identities
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

/**
 * Stored Keys — server-side encrypted private key storage
 */
export const storedKeys = authSchema.table('stored_keys', {
  id: text('id').primaryKey(),                          // key_{nanoid}
  did: text('did').notNull().references(() => identities.id),
  encryptedKey: text('encrypted_key').notNull(),        // client-side AES-256-GCM ciphertext
  salt: text('salt').notNull(),                         // PBKDF2 salt (client-side)
  keyDerivation: text('key_derivation').notNull().default('pbkdf2'),
  deviceFingerprint: text('device_fingerprint'),        // optional, which device stored this
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => ({
  didUniq: uniqueIndex('idx_stored_keys_did').on(table.did),
}));

/**
 * MFA Methods — registered MFA methods per identity
 */
export const mfaMethods = authSchema.table('mfa_methods', {
  id: text('id').primaryKey(),                          // mfa_{nanoid}
  did: text('did').notNull().references(() => identities.id),
  type: text('type').notNull(),                         // 'totp' | 'passkey' | 'recovery_code'
  secret: text('secret').notNull(),                     // AES-256-GCM encrypted server-side
  name: text('name').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),  // null = setup not completed
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => ({
  didIdx: index('idx_mfa_methods_did').on(table.did),
}));

/**
 * Devices — known devices per identity
 */
export const devices = authSchema.table('devices', {
  id: text('id').primaryKey(),                          // dev_{nanoid}
  did: text('did').notNull().references(() => identities.id),
  fingerprint: text('fingerprint').notNull(),           // SHA-256(ip + userAgent)
  name: text('name'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  trusted: boolean('trusted').notNull().default(false),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didFingerprintUniq: uniqueIndex('idx_devices_did_fingerprint').on(table.did, table.fingerprint),
  didIdx: index('idx_devices_did').on(table.did),
}));

/**
 * Group Identities — multi-controller DIDs for orgs, communities, families
 */
export const groupIdentities = authSchema.table('group_identities', {
  groupDid: text('group_did').primaryKey(),               // references identities.id
  scope: text('scope').notNull(),                         // 'org' | 'community' | 'family'
  createdBy: text('created_by').notNull(),                // DID of creator
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * Group Controllers — members that control a group DID
 */
export const groupControllers = authSchema.table('group_controllers', {
  groupDid: text('group_did').notNull(),
  controllerDid: text('controller_did').notNull(),
  role: text('role').notNull().default('member'),         // 'owner' | 'admin' | 'member'
  allowedServices: text('allowed_services').array(),      // null = full access, ['events','pay'] = restricted
  addedBy: text('added_by'),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (table) => ({
  pk: index('idx_group_controllers_pk').on(table.groupDid, table.controllerDid),
  controllerIdx: index('idx_group_controllers_controller').on(table.controllerDid),
}));

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
export type IdentityChain = typeof identityChains.$inferSelect;
export type NewIdentityChain = typeof identityChains.$inferInsert;
export type StoredKey = typeof storedKeys.$inferSelect;
export type NewStoredKey = typeof storedKeys.$inferInsert;
export type MfaMethod = typeof mfaMethods.$inferSelect;
export type NewMfaMethod = typeof mfaMethods.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type GroupIdentity = typeof groupIdentities.$inferSelect;
export type NewGroupIdentity = typeof groupIdentities.$inferInsert;
export type GroupController = typeof groupControllers.$inferSelect;
export type NewGroupController = typeof groupControllers.$inferInsert;
