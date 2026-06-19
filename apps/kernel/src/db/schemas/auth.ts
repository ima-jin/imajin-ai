import { text, timestamp, jsonb, integer, boolean, index, uniqueIndex, pgSchema } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

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
  scope: text('scope').notNull(),                 // 'actor' | 'family' | 'community' | 'business'
  subtype: text('subtype'),                       // scope-dependent: 'human' | 'agent' | 'device' | etc.
  publicKey: text('public_key').notNull().unique(),
  handle: text('handle').unique(),                // @username (unique, optional)
  name: text('name'),                             // Display name
  avatarUrl: text('avatar_url'),
  avatarAssetId: text('avatar_asset_id'),           // asset_xxx from media service
  tier: text('tier').notNull().default('soft'),
  uploadLimitMb: integer('upload_limit_mb'),
  handleClaimedAt: timestamp('handle_claimed_at', { withTimezone: true }),
  contactEmail: text('contact_email'),                  // billing/notification email from Stripe or onboard
  keyRoles: jsonb('key_roles').$type<KeyRoles | null>(), // null = single key in all roles
  metadata: jsonb('metadata').default({}),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
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
  pollHandle: text('poll_handle').unique(),
  handoffToken: text('handoff_token').unique(),
  handoffUsedAt: timestamp('handoff_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tokenIdx: index('idx_auth_onboard_tokens_token').on(table.token),
  emailIdx: index('idx_auth_onboard_tokens_email').on(table.email),
  pollHandleIdx: index('idx_auth_onboard_tokens_poll_handle').on(table.pollHandle),
  handoffTokenIdx: index('idx_auth_onboard_tokens_handoff_token').on(table.handoffToken),
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
  attestationStatus: text('attestation_status').default('pending'), // 'pending' | 'bilateral' | 'declined' | 'collecting' | 'executed' | 'expired'
  documentHash: text('document_hash'),                 // sha256 of signed document
  documentAssetId: text('document_asset_id'),          // references media.assets.id
  totalSigners: integer('total_signers'),              // expected number of signatures
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
 * Attestation Signatures — multi-party signing records
 */
export const attestationSignatures = authSchema.table('attestation_signatures', {
  id: text('id').primaryKey(),                         // sig_xxx
  attestationId: text('attestation_id').notNull().references(() => attestations.id, { onDelete: 'cascade' }),
  signerDid: text('signer_did').notNull(),
  jws: text('jws'),                                    // JWS compact token
  signedAt: timestamp('signed_at', { withTimezone: true }),
  status: text('status').notNull().default('pending'), // 'pending' | 'signed' | 'declined'
  role: text('role').notNull().default('signer'),      // 'creator' | 'signer'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  attIdx: index('idx_attestation_sigs_att').on(table.attestationId),
  signerIdx: index('idx_attestation_sigs_signer').on(table.signerDid),
  statusIdx: index('idx_attestation_sigs_status').on(table.status),
}));

export const attestationRelations = relations(attestations, ({ many }) => ({
  signatures: many(attestationSignatures),
}));

export const attestationSignatureRelations = relations(attestationSignatures, ({ one }) => ({
  attestation: one(attestations, {
    fields: [attestationSignatures.attestationId],
    references: [attestations.id],
  }),
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
 * Identity Members — members of a group/collective identity
 */
export const identityMembers = authSchema.table('identity_members', {
  identityDid: text('identity_did').notNull(),
  memberDid: text('member_did').notNull(),
  role: text('role').notNull().default('member'),         // 'owner' | 'admin' | 'maintainer' | 'member' | 'agent' | ...
  allowedServices: text('allowed_services').array(),      // null = full access, ['events','pay'] = restricted
  addedBy: text('added_by'),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (table) => ({
  pk: index('idx_identity_members_pk').on(table.identityDid, table.memberDid),
  memberIdx: index('idx_identity_members_member').on(table.memberDid),
}));

/**
 * Channel Link Tokens — single-use challenge tokens for the messenger linking handshake.
 * Bot creates a token; user opens the URL and approves; token consumed on approve.
 */
export const channelLinkTokens = authSchema.table('channel_link_tokens', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  channel: text('channel').notNull(),                        // 'telegram' | 'whatsapp' | 'signal'
  channelUid: text('channel_uid').notNull(),                 // external account id
  appDid: text('app_did').notNull(),                         // bot app DID
  requestedScopes: jsonb('requested_scopes').notNull().default([]),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  consumedBy: text('consumed_by'),                           // Imajin DID that approved
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenIdx: index('idx_channel_link_tokens_token').on(table.token),
  pendingIdx: index('idx_channel_link_tokens_pending').on(table.expiresAt).where(sql`${table.consumedAt} IS NULL`),
}));

/**
 * Channel Links — persistent binding of external channel accounts to Imajin DIDs.
 * Enables the bot to resolve a chat user to their DID for actingFor delegation.
 */
export const channelLinks = authSchema.table('channel_links', {
  id: text('id').primaryKey(),
  channel: text('channel').notNull(),                        // 'telegram' | 'whatsapp' | 'signal'
  channelUid: text('channel_uid').notNull(),                 // external account id
  did: text('did').notNull(),                                // linked Imajin user DID
  appDid: text('app_did').notNull(),                         // bot app this link authorizes
  scopes: jsonb('scopes').notNull().default([]),             // approved scopes
  status: text('status').notNull().default('active'),        // 'active' | 'revoked'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  didIdx: index('idx_channel_links_did').on(table.did),
  lookupIdx: index('idx_channel_links_lookup').on(table.channel, table.channelUid, table.status),
  pairUnique: uniqueIndex('uniq_channel_links_pair').on(table.channel, table.channelUid, table.appDid),
}));

// Types
export type Identity = typeof identities.$inferSelect;
export type NewIdentity = typeof identities.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type OnboardToken = typeof onboardTokens.$inferSelect;
export type Attestation = typeof attestations.$inferSelect;
export type NewAttestation = typeof attestations.$inferInsert;
export type AttestationSignature = typeof attestationSignatures.$inferSelect;
export type NewAttestationSignature = typeof attestationSignatures.$inferInsert;
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
export type IdentityMember = typeof identityMembers.$inferSelect;
export type NewIdentityMember = typeof identityMembers.$inferInsert;
export type ChannelLinkToken = typeof channelLinkTokens.$inferSelect;
export type NewChannelLinkToken = typeof channelLinkTokens.$inferInsert;
export type ChannelLink = typeof channelLinks.$inferSelect;
export type NewChannelLink = typeof channelLinks.$inferInsert;
