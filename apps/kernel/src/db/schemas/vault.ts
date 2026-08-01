import { pgSchema, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Vault delegation grants — stores ECDH-wrapped field keys that allow the
 * cloud node (or another agent) to unseal delegation-grant-sealed vault entries
 * without requiring the owner to be online at action time (#1242).
 *
 * Each row represents the owner agent granting a specific recipient (e.g. the
 * cloud node) the ability to unseal a specific vault field. The `wrapped_key`
 * is the per-field AES-256-GCM seal key, ECDH-wrapped to the recipient's
 * X25519 public key. The owner's X25519 public key (`owner_x_pub`) is stored
 * so the recipient can re-derive the ECDH shared secret at unseal time.
 *
 * The `owner_signature` covers the canonical form of the grant payload and is
 * verified before the wrapped key is accepted, preventing a compromised node
 * from injecting grants.
 *
 * Custody disclosure: under Tier 0 (node-derived X25519 key) the custody
 * boundary is the same as v1. Under Tier 1 (imajin-cli vault serve / mobile
 * app / Unit), the owner's vault X25519 key never leaves hardware they control,
 * and the cloud node can only unseal fields for which an active grant exists.
 */
export const vaultSchema = pgSchema('kernel');

export const vaultDelegationGrants = vaultSchema.table('vault_delegation_grants', {
  id: text('id').primaryKey(),                          // vdg_{nanoid}
  subject: text('subject').notNull(),                   // ownerDid granting access
  grantedTo: text('granted_to').notNull(),              // nodeDid / agentDid receiving access
  field: text('field').notNull(),                       // vault field name (e.g. 'GH_TOKEN')
  ownerXPub: text('owner_x_pub').notNull(),             // owner agent's X25519 pubkey (32-byte hex)
  wrappedKey: text('wrapped_key').notNull(),            // base64: AES-GCM(fieldKey) sealed to grantedTo's X25519 key
  wrappedNonce: text('wrapped_nonce').notNull(),        // base64: 12-byte AES-GCM IV for wrappedKey
  keyId: text('key_id').notNull(),                      // vault entry keyId this grant covers
  ownerSignature: text('owner_signature').notNull(),    // Ed25519 sig over canonical grant payload
  status: text('status').notNull().default('active'),   // 'active' | 'revoked' | 'superseded'
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),

  // Recipient's X25519 pubkey. ECDH needs the counterparty key, so without this a
  // grant row cannot be opened by the owner on its own. Nullable: rows written
  // before #1521 predate it.
  recipientXPub: text('recipient_x_pub'),

  // The Ed25519 pubkey this grant's ownerSignature must verify against, pinned at
  // creation. Previously the verifier was chosen from a process-wide Tier 1 flag,
  // which made Tier 1 a one-way door and stopped Tier-0 and Tier-1 grants
  // coexisting. Nullable: rows written before #1521 fall back to the old rule.
  ownerEdPub: text('owner_ed_pub'),
}, (table) => ({
  // Primary lookup: node checks for its own active grants on a given field.
  grantedToFieldIdx: index('idx_vault_delegation_granted_to_field')
    .on(table.grantedTo, table.field, table.status),
  // Subject lookup: owner lists / revokes their own grants.
  subjectIdx: index('idx_vault_delegation_subject')
    .on(table.subject, table.status),
  // Expiry sweep: background cleanup of expired active grants.
  expiresIdx: index('idx_vault_delegation_expires')
    .on(table.expiresAt)
    .where(sql`${table.expiresAt} IS NOT NULL AND ${table.status} = 'active'`),
  // Uniqueness: one ACTIVE grant per (subject, grantedTo, field, keyId) tuple.
  // Rotation supersedes the previous grant before inserting a new one.
  //
  // The status predicate is load-bearing. keyId derives from the node's signing
  // key and is constant, so without it the tuple is effectively (owner, node,
  // field) for all time: the superseded row keeps occupying it and the
  // replacement insert fails. That made re-sealing a v2 field impossible on the
  // second write, and renewal impossible at all. Fixed in migration 0079 — it
  // went unnoticed because nothing writes v2 in production and the tests mock
  // the database, so no real UNIQUE was ever exercised.
  activeGrantUniq: uniqueIndex('uniq_vault_delegation_active')
    .on(table.subject, table.grantedTo, table.field, table.keyId)
    .where(sql`${table.status} = 'active'`),
}));

export type VaultDelegationGrant = typeof vaultDelegationGrants.$inferSelect;
export type NewVaultDelegationGrant = typeof vaultDelegationGrants.$inferInsert;

/**
 * Vault grant requests — pending Tier 1 grant requests awaiting the external owner agent.
 *
 * When sealAndStoreV2 runs in Tier 1 mode (VAULT_OWNER_X_PUB + VAULT_OWNER_ED_PUB set),
 * it wraps the per-field AES key from nodeXPriv → ownerXPub and stores a pending row here
 * instead of creating a self-grant. The owner agent (imajin-cli vault serve) polls
 * GET /api/vault/grants/pending, recovers the field key, re-wraps it as a proper
 * delegation grant, and POSTs it to POST /api/vault/delegation/grant.
 *
 * wrappedFieldKey / wrappedFieldKeyNonce:
 *   fieldKey ECDH-wrapped wrapFieldKey(fieldKey, ownerXPub, nodeXPriv).
 *   Only the owner — who holds ownerXPriv — can recover it via
 *   unwrapFieldKey({ encryptedKey: wrappedFieldKey, nonce: wrappedFieldKeyNonce }, nodeXPub, ownerXPriv).
 */
export const vaultGrantRequests = vaultSchema.table('vault_grant_requests', {
  id: text('id').primaryKey(),                               // vgr_{nanoid}
  field: text('field').notNull(),                            // vault field name, e.g. 'GH_TOKEN'
  keyId: text('key_id').notNull(),                           // keyId of the corresponding vault entry
  requestId: text('request_id').notNull(),                   // UUID correlation ID
  nodeXPub: text('node_x_pub').notNull(),                    // node's X25519 pubkey (32-byte hex)
  ownerXPub: text('owner_x_pub').notNull(),                  // expected owner's X25519 pubkey
  wrappedFieldKey: text('wrapped_field_key').notNull(),       // base64: fieldKey wrapped nodeXPriv→ownerXPub
  wrappedFieldKeyNonce: text('wrapped_field_key_nonce').notNull(), // base64: 12-byte AES-GCM IV
  status: text('status').notNull().default('pending'),        // 'pending' | 'fulfilled' | 'expired'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
  grantId: text('grant_id'),                                 // FK → vault_delegation_grants.id once fulfilled
}, (table) => ({
  requestIdUniq: uniqueIndex('uniq_vault_grant_request_id').on(table.requestId),
  statusIdx: index('idx_vault_grant_requests_status').on(table.status),
  fieldStatusIdx: index('idx_vault_grant_requests_field_status').on(table.field, table.status),
}));

export type VaultGrantRequest = typeof vaultGrantRequests.$inferSelect;
export type NewVaultGrantRequest = typeof vaultGrantRequests.$inferInsert;

/**
 * Vault owner envelopes — the owner's durable, recoverable copy of a field key (#1521).
 *
 * A v2 entry is encrypted with a random per-field AES key. Before this table, that
 * key survived in exactly two places: the delegation grant (wrapped to the node),
 * and — incidentally — the fulfilled `vault_grant_requests` row (wrapped to the
 * owner). Nothing recorded that the request queue was load-bearing, so pruning it
 * would have destroyed the owner's only copy of every field key.
 *
 * The envelope makes that copy explicit. It is written as
 * `wrapFieldKey(fieldKey, ownerXPub, nodeXPriv)` and opened by the owner with
 * `unwrapFieldKey({ encryptedKey: wrappedKey, nonce: wrappedNonce }, senderXPub, ownerXPriv)`
 * — so `senderXPub` is the wrapper's (node's) pubkey, not the owner's.
 *
 * Two things depend on it:
 *   - **Renewal and porting.** The owner can re-issue a grant after expiry or
 *     revocation, or issue one to a different recipient, with no cooperation from
 *     the node holding the current grant.
 *   - **Safe crypto-erase.** A grant's wrapped key may only be erased when an
 *     envelope exists for the same (field, keyId), so revocation can never destroy
 *     the last recoverable copy.
 */
export const vaultOwnerEnvelopes = vaultSchema.table('vault_owner_envelopes', {
  id: text('id').primaryKey(),                          // vwe_{nanoid}
  field: text('field').notNull(),                       // vault field name
  keyId: text('key_id').notNull(),                      // keyId of the entry this envelope covers
  ownerXPub: text('owner_x_pub').notNull(),             // owner's X25519 pubkey the key is wrapped TO
  senderXPub: text('sender_x_pub').notNull(),           // wrapper's X25519 pubkey; ECDH counterparty for unwrap
  wrappedKey: text('wrapped_key').notNull(),            // base64: fieldKey wrapped to ownerXPub
  wrappedNonce: text('wrapped_nonce').notNull(),        // base64: 12-byte AES-GCM IV
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // keyId identifies the signing key, not the entry — it is derived from the node's
  // Ed25519 pubkey and is constant across re-seals. This row is therefore upserted
  // and always holds the CURRENT field key. Superseded generations are deliberately
  // not retained, so a re-seal crypto-erases the previous value.
  fieldKeyIdUniq: uniqueIndex('uniq_vault_owner_envelope').on(table.field, table.keyId),
  // Used by the erase guard and by owner-side renewal / porting.
  fieldIdx: index('idx_vault_owner_envelopes_field').on(table.field),
}));

export type VaultOwnerEnvelope = typeof vaultOwnerEnvelopes.$inferSelect;
export type NewVaultOwnerEnvelope = typeof vaultOwnerEnvelopes.$inferInsert;
