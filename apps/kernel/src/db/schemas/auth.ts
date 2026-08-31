import { text, timestamp, jsonb, integer, boolean, index, uniqueIndex, pgSchema } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { DelegationAudience } from '@imajin/auth';

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
  // Phase 2 of #1834: the connections-invite code (if any) that started
  // this onboarding round trip. Lets /api/onboard/verify re-resolve
  // invite context (scopeDid, pendingAttestationId) from the invite row
  // server-side by code, rather than trusting a client-supplied param.
  inviteCode: text('invite_code'),
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
  inviteCodeIdx: index('idx_auth_onboard_tokens_invite_code').on(table.inviteCode),
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
  nostrSig: text('nostr_sig'),                          // secp256k1 Schnorr hex (imajin/nostr-key-binding proof-of-control)
  authorJws: text('author_jws'),                       // JWS compact token (author signature)
  witnessJws: text('witness_jws'),                     // JWS compact token (countersignature)
  attestationStatus: text('attestation_status').default('pending'), // 'pending' | 'bilateral' | 'declined' | 'superseded' | 'collecting' | 'executed' | 'expired' | 'lapsed'
  documentHash: text('document_hash'),                 // sha256 of signed document
  documentAssetId: text('document_asset_id'),          // references media.assets.id
  totalSigners: integer('total_signers'),              // expected number of signatures
  // Intro-funnel envelope fields (#1885). subject/actor/timestamp are
  // already covered by subjectDid/issuerDid/issuedAt above.
  delegatorDid: text('delegator_did'),                  // optional DID that authorized issuerDid to act (actingFor-style delegation)
  disclosureScope: text('disclosure_scope').notNull().default('parties'), // 'parties' | 'connections' | 'network' | 'public' — closed enum, DB CHECK-constrained
  // Immediate predecessor attestation id — makes a funnel a verifiable chain.
  // Plain column (no Drizzle .references() to avoid a circular self-type),
  // same convention as messagesV2.replyToMessageId; the FK constraint is
  // enforced at the DB level by migrations/0101_attestation_funnel_envelope.sql.
  prevEventRef: text('prev_event_ref'),
  // The delegation_grants(id) the write path verified `delegator_did` against
  // at issuance time (#1895, #1897) — null when delegatorDid is absent/self.
  // Plain column (no Drizzle .references(), same convention as prevEventRef
  // above) since delegation_grants is declared later in this file; the FK
  // constraint is enforced at the DB level by
  // migrations/0107_attestation_delegation_grant.sql.
  delegationGrantId: text('delegation_grant_id'),
  // Amendment-by-supersession (#1790): the bilateral attestation (v1) this
  // row proposes to amend, if any. Distinct from prevEventRef — that column
  // is deliberately side-effect-free funnel-chain plumbing, while this one
  // drives an atomic status flip (v1 -> 'superseded') on countersign. Plain
  // column (no Drizzle .references(), same convention as prevEventRef and
  // delegationGrantId above); the FK constraint is enforced at the DB level
  // by migrations/0109_attestation_supersedes.sql. Eligibility (proposer
  // must be party to v1, and v1 must be bilateral) is validated at creation
  // time and re-verified atomically at countersign time — see
  // app/auth/api/attestations/attestation-helpers.ts.
  supersedes: text('supersedes'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // Stamped when this attestation is cascaded to attestation_status='lapsed'
  // by the claim-stub-expiry sweep (#1841) — distinct from expiresAt/expired,
  // which is this attestation's own TTL, orthogonal to its subject's stub
  // lapsing out from under it. See migrations/0112_claim_stub_expiry.sql.
  lapsedAt: timestamp('lapsed_at', { withTimezone: true }),
}, (table) => ({
  subjectIdx: index('idx_auth_attestations_subject').on(table.subjectDid),
  issuerIdx: index('idx_auth_attestations_issuer').on(table.issuerDid),
  typeIdx: index('idx_auth_attestations_type').on(table.type),
  statusIdx: index('idx_auth_attestations_status').on(table.attestationStatus),
  expiresIdx: index('idx_auth_attestations_expires').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
  prevEventRefIdx: index('idx_auth_attestations_prev_event_ref').on(table.prevEventRef).where(sql`${table.prevEventRef} IS NOT NULL`),
  disclosureScopeIdx: index('idx_auth_attestations_disclosure_scope').on(table.disclosureScope),
  delegationGrantIdx: index('idx_auth_attestations_delegation_grant').on(table.delegationGrantId).where(sql`${table.delegationGrantId} IS NOT NULL`),
  supersedesIdx: index('idx_auth_attestations_supersedes').on(table.supersedes).where(sql`${table.supersedes} IS NOT NULL`),
}));

/**
 * Attestation Type Registry — registry-as-data (#1885). Platform-seeded rows
 * (namespace='platform') ship the intro-funnel vocabulary; third parties
 * register new types under their own namespace via
 * POST /auth/api/attestations/types, gated on requireEstablishedDID.
 *
 * Additive: the compile-time ATTESTATION_TYPES array in @imajin/auth is
 * unchanged and keeps validating pre-existing types with zero DB hits. This
 * table is the extension surface for types that don't ship in a release.
 */
export const attestationTypeRegistry = authSchema.table('attestation_type_registry', {
  typeName: text('type_name').primaryKey(),
  namespace: text('namespace').notNull().default('platform'),
  registeredByDid: text('registered_by_did'),           // null for platform-seeded entries
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  namespaceIdx: index('idx_attestation_type_registry_namespace').on(table.namespace),
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
  addedVia: text('added_via'),                            // 'direct' | 'invite' | 'agent' | 'claim' | null = unknown (#1680)
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
  optInRef: text('opt_in_ref'),                                     // opaque opt-in ref that authorized this agent delegation (#1442)
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

/**
 * Claim Stub Index — email-keyed dedup index for the claimable-stub
 * primitive (#1834 Phase 1).
 *
 * Keyed by a salted/peppered HMAC-SHA256 of the normalised email (never the
 * plaintext), so a second introduction of the same email can be matched and
 * silently accrued to the same stub `identities` row without ever exposing
 * whether the email already existed ("match-without-disclosure").
 *
 * `emailEncrypted` holds the email AES-256-GCM-encrypted at rest with a
 * server-held key derived from the same secret as the HMAC — needed so the
 * reminder ladder (catalyst-power/xprize#75) can re-send later without
 * asking the introducer to supply the email again. No plaintext email is
 * ever stored here or searchable via this table.
 *
 * `claimantVerifiedAt` is one half of the ratcheted bilateral claim (#1834
 * ratified design pt. 3): set when the claimant proves ownership of the
 * email. The other half — the inviter-side countersign — is read from
 * `connections.invites` (an accepted invite whose `toDid` is this stub's
 * DID) rather than duplicated here.
 */
export const claimStubIndex = authSchema.table('claim_stub_index', {
  // Synthetic PK (migration 0109, #1841 design consideration 3). Lets an
  // expired row's email_hmac be reused by a fresh mint via the partial
  // unique index below, instead of email_hmac itself gating inserts.
  id: text('id').primaryKey(),                    // cstub_{nanoid} (backfilled as cstub_{email_hmac} for pre-0109 rows)
  emailHmac: text('email_hmac').notNull(),
  did: text('did').notNull().unique().references(() => identities.id),
  emailEncrypted: text('email_encrypted').notNull(),
  claimantVerifiedAt: timestamp('claimant_verified_at', { withTimezone: true }),
  // 'active' | 'expired' (#1841). Tombstone, never delete: an expired row
  // is retained as-is (email_hmac/email_encrypted untouched) so a later
  // re-introduction of the same email recognizes a prior stub existed.
  stubStatus: text('stub_status').notNull().default('active'),
  stubExpiresAt: timestamp('stub_expires_at', { withTimezone: true }),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  didIdx: index('idx_claim_stub_index_did').on(table.did),
  // Enforces "at most one LIVE claimable stub DID per email" (#1841) rather
  // than the pre-0109 "exactly one DID ever" — a fresh mint can insert a new
  // row for the same email_hmac once the prior row is stub_status='expired'.
  activeEmailIdx: uniqueIndex('uniq_claim_stub_index_active_email').on(table.emailHmac).where(sql`${table.stubStatus} = 'active'`),
  expiryIdx: index('idx_claim_stub_index_expiry').on(table.stubExpiresAt).where(sql`${table.stubStatus} = 'active'`),
}));

/**
 * Scoped delegation grants for external agents (#1882) — grant/revoke
 * lifecycle for `domain:verb` capabilities, independent from the coarse
 * X-Acting-For agent bootstrap in `identity_members` (role='agent').
 *
 * Fail-closed by construction: `status` only ever moves active -> revoked
 * (there is no automatic "expired" transition), and `expires_at` is compared
 * at introspection time rather than swept in the background — a lookup after
 * expiry fails a plain timestamp comparison, not a stale cached status.
 *
 * Renewal (#1882 item 4, "grants are leases with expiry") updates
 * `expires_at` in place; no lineage row is kept for the previous expiry.
 */
export const delegationGrants = authSchema.table('delegation_grants', {
  id: text('id').primaryKey(),                          // grant_{nanoid}
  agentDid: text('agent_did').notNull(),                // external agent the grant is issued to
  delegatorDid: text('delegator_did').notNull(),        // principal who issued the grant (user-push only)
  audience: jsonb('audience').notNull().$type<DelegationAudience>(),
  onBehalfOf: jsonb('on_behalf_of').notNull().default([]).$type<string[]>(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active'),   // 'active' | 'revoked'
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // #1887 grants-view read surface: last successful introspectGrant() hit
  // against this grant (any capability). Not a per-capability timestamp —
  // see delegationGrantEvents below for the capability-level audit trail.
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  agentIdx: index('idx_delegation_grants_agent').on(table.agentDid, table.status),
  delegatorIdx: index('idx_delegation_grants_delegator').on(table.delegatorDid, table.status),
  expiresIdx: index('idx_delegation_grants_expires').on(table.expiresAt).where(sql`${table.status} = 'active'`),
}));

/**
 * Grant lifecycle audit trail (#1887 grants-view read surface: "audit trail
 * ... action history under the grant"). Records the lifecycle events this
 * codebase actually performs on a grant — issue/renew/revoke/capability
 * revoke — so revoked/expired grants stay visible in history even after
 * their authority is gone ("the record doesn't disappear because the
 * authority did"). This is deliberately narrower than a general delegated-
 * action log (#1882's dual-stamp provenance chain for arbitrary actions is
 * still an open question per #1882's "grants as attestations?" note) — it
 * only ever gets a row from the grants.ts lifecycle functions themselves.
 */
export const delegationGrantEvents = authSchema.table('delegation_grant_events', {
  id: text('id').primaryKey(),                          // gevt_{nanoid}
  grantId: text('grant_id').notNull().references(() => delegationGrants.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),                       // 'issued' | 'renewed' | 'revoked' | 'capability_revoked'
  capability: text('capability'),                       // set only for 'capability_revoked'
  actorDid: text('actor_did').notNull(),                // the delegator who performed the action
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  grantIdx: index('idx_delegation_grant_events_grant').on(table.grantId, table.createdAt),
}));

/**
 * One row per capability within a grant, so a single `domain:verb` scope can
 * be revoked independently of its siblings and the parent grant (#1882
 * item 4).
 */
export const delegationGrantCapabilities = authSchema.table('delegation_grant_capabilities', {
  id: text('id').primaryKey(),                          // gcap_{nanoid}
  grantId: text('grant_id').notNull().references(() => delegationGrants.id, { onDelete: 'cascade' }),
  capability: text('capability').notNull(),             // domain:verb scope string
  status: text('status').notNull().default('active'),   // 'active' | 'revoked'
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  grantCapabilityUniq: uniqueIndex('uniq_delegation_grant_capability').on(table.grantId, table.capability),
  lookupIdx: index('idx_delegation_grant_capabilities_lookup').on(table.grantId, table.capability, table.status),
}));

export type DelegationGrantRow = typeof delegationGrants.$inferSelect;
export type NewDelegationGrantRow = typeof delegationGrants.$inferInsert;
export type DelegationGrantCapabilityRow = typeof delegationGrantCapabilities.$inferSelect;
export type NewDelegationGrantCapabilityRow = typeof delegationGrantCapabilities.$inferInsert;
export type DelegationGrantEventRow = typeof delegationGrantEvents.$inferSelect;
export type NewDelegationGrantEventRow = typeof delegationGrantEvents.$inferInsert;

/**
 * External-agent knocks (#1883) — pending contact requests from an
 * external agent to a declared target principal, settled at the #1881
 * Day-1 review (2026-08-30). "Knock, not registration": the agent's
 * `public_key` sits here in escrow — it is never written to
 * `auth.identities` until the declared target accepts. Declining or letting
 * a knock expire leaves no identity behind at all.
 *
 * `agent_did` is the did:imajin address deterministically derived from
 * `public_key` (see `didFromPublicKey`) — computed at knock time so a
 * multi-tenant agent's *second* knock (to a different target, same keypair)
 * can be recognized as the same prospective/actual identity without an
 * extra lookup. It only becomes a real row in `identities` on the *first*
 * accepted knock for that key; every later accept reuses it ("the DID is
 * minted once ... declaration is per-knock; identity is singular").
 *
 * Fail-closed by construction, same convention as `delegation_grants`:
 * `status` only ever moves pending -> accepted | declined — there is no
 * background "expired" transition. `expires_at` is compared as a plain
 * timestamp at list/accept/decline time.
 */
export const agentKnocks = authSchema.table('agent_knocks', {
  id: text('id').primaryKey(),                          // knock_{nanoid}
  publicKey: text('public_key').notNull(),              // Ed25519 hex, escrowed — not yet in identities.public_key
  agentDid: text('agent_did').notNull(),                // did:imajin derived from public_key (prospective until accept)
  declaredTarget: text('declared_target').notNull(),    // resolved DID of the existing principal the agent wants to serve
  selfDescription: text('self_description'),
  requestedCapabilities: jsonb('requested_capabilities').notNull().default([]).$type<string[]>(), // advisory only — never authority (#1882 grants are separate)
  externalDid: text('external_did'),                    // optional bring-your-own DID (e.g. did:web:boardy.ai); recorded as an attestation on accept, never used for auth
  // #1900: computed once at knock-submission time (never re-derived in the
  // background) so the pending-review surface can label the claim before
  // accept. NULL when no external_did was declared. See
  // migrations/0108_knock_external_did_verification.sql for the CHECK
  // constraint enumerating the closed 'verified' | 'declared_unverified' |
  // 'resolution_failed' set.
  externalDidVerification: text('external_did_verification'),
  externalDidVerifiedAt: timestamp('external_did_verified_at', { withTimezone: true }),
  status: text('status').notNull().default('pending'),  // 'pending' | 'accepted' | 'declined'
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  targetStatusIdx: index('idx_agent_knocks_target_status').on(table.declaredTarget, table.status),
  agentDidIdx: index('idx_agent_knocks_agent_did').on(table.agentDid),
  pendingLookupIdx: index('idx_agent_knocks_pending_lookup').on(table.publicKey, table.declaredTarget, table.status),
}));

export type AgentKnockRow = typeof agentKnocks.$inferSelect;
export type NewAgentKnockRow = typeof agentKnocks.$inferInsert;

/**
 * Intro-attribution grant-time terms (#1886) — the matchmaking agent's
 * declared 70/15/15 split + attribution window, consented by the
 * delegator at the moment they issue an `intros:propose` grant (#1882).
 * A side table keyed 1:1 on `delegation_grants(id)` rather than columns on
 * that table, so the core grant lifecycle stays untouched by this
 * template's concerns ("compose, don't rebuild" — #1886 rides #1882's
 * grant object, it doesn't extend it).
 *
 * Deliberately NOT tied to `delegation_grants.expires_at` for its own
 * validity: attribution survives grant expiry (expiry severs authority,
 * never attribution — #1886 invariant 8), bounded instead by
 * `attribution_window_days` measured from the funnel's own `intro_made`
 * attestation.
 */
export const introAttributionTerms = authSchema.table('intro_attribution_terms', {
  id: text('id').primaryKey(),                                      // iat_{nanoid}
  grantId: text('grant_id').notNull().unique().references(() => delegationGrants.id, { onDelete: 'cascade' }),
  knockId: text('knock_id').references(() => agentKnocks.id),       // originating #1883 knock, if any
  delegatorDid: text('delegator_did').notNull(),                    // consenting principal (== grant.delegatorDid)
  matchmakerDid: text('matchmaker_did').notNull(),                  // agent DID (== grant.agentDid)
  matchmakerShareBps: integer('matchmaker_share_bps').notNull().default(7000),
  partyAShareBps: integer('party_a_share_bps').notNull().default(1500),
  partyBShareBps: integer('party_b_share_bps').notNull().default(1500),
  attributionWindowDays: integer('attribution_window_days').notNull().default(365),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  grantIdx: index('idx_intro_attribution_terms_grant').on(table.grantId),
  delegatorIdx: index('idx_intro_attribution_terms_delegator').on(table.delegatorDid),
}));

export type IntroAttributionTermsRow = typeof introAttributionTerms.$inferSelect;
export type NewIntroAttributionTermsRow = typeof introAttributionTerms.$inferInsert;

// Types
export type Identity = typeof identities.$inferSelect;
export type NewIdentity = typeof identities.$inferInsert;
export type ClaimStubIndex = typeof claimStubIndex.$inferSelect;
export type NewClaimStubIndex = typeof claimStubIndex.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type OnboardToken = typeof onboardTokens.$inferSelect;
export type Attestation = typeof attestations.$inferSelect;
export type NewAttestation = typeof attestations.$inferInsert;
export type AttestationSignature = typeof attestationSignatures.$inferSelect;
export type NewAttestationSignature = typeof attestationSignatures.$inferInsert;
export type AttestationTypeRegistryRow = typeof attestationTypeRegistry.$inferSelect;
export type NewAttestationTypeRegistryRow = typeof attestationTypeRegistry.$inferInsert;
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
