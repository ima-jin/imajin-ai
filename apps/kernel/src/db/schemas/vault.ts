import { pgSchema, text, timestamp, boolean, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
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

  // ── Remote human -> agent credential handoff (#2231) ──────────────────────
  //
  // These three columns are deliberately NOT part of `canonicalizeGrantPayload`'s
  // signed fields: that canonical form is already load-bearing for every existing
  // grant, and every unseal re-verifies `ownerSignature` against it — adding a key
  // would change the canonical string and break signature verification for every
  // grant signed before this migration. `purpose` and `oneTime` are therefore
  // authorization-adjacent bookkeeping, not cryptographically bound scope: the
  // actual access boundary remains (subject, grantedTo, field), unchanged by them.

  // Free-form label naming what the grantee intends to use the secret for (e.g.
  // 'gha-runner-registration'), so a grantee can enumerate its own grants by
  // intent without ever seeing wrapped key material. Null for grants issued
  // before this column existed, and for self-grants that don't need one.
  purpose: text('purpose'),
  // Single-use grants (e.g. a one-shot runner-registration token): the first
  // successful GET of the sealed value via the agent-fetch route consumes the
  // grant. Defaults false so every pre-existing and ordinary grant stays
  // multi-read, matching prior behaviour exactly.
  oneTime: boolean('one_time').notNull().default(false),
  // Set the moment a `oneTime` grant is successfully fetched. A second fetch
  // sees this populated and is refused with 410 Gone rather than re-reading the
  // secret. Always null for a non-`oneTime` grant.
  consumedAt: timestamp('consumed_at', { withTimezone: true }),

  // ── Agent ack (#2235) ──────────────────────────────────────────────────
  //
  // Same non-canonical bookkeeping posture as purpose/oneTime/consumedAt
  // above: none of these four columns are part of `canonicalizeGrantPayload`.

  // Set by `fetchGrantSecret` on every successful decrypt (one-time or
  // reusable), synchronously — not derived from the `vault.delegation.fetched`
  // audit event, which is a fire-and-forget publish and would race an ack
  // that follows immediately behind its own fetch. This is the precondition
  // POST .../ack checks: null means "never successfully fetched", so acking
  // is refused with 409 grant_not_fetched.
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
  // Set the moment the grantee successfully acks (idempotent: a repeat ack
  // with the SAME outcome is accepted; a DIFFERENT outcome is a 409 conflict).
  ackedAt: timestamp('acked_at', { withTimezone: true }),
  // 'used' | 'failed' | 'discarded' — enforced by a CHECK constraint at the
  // DB level (migration 0149), not just application validation.
  ackOutcome: text('ack_outcome'),
  // Optional evidence + free-text note the grantee attaches, e.g.
  // { kind: 'gha-runner', ref: 'imajin-gx10', note: 'registered gx10 ok' }.
  // The route body has separate `evidence: { kind, ref }` and `note` fields;
  // both fold into this single jsonb column rather than adding a fourth
  // migration 0149 column for `note` alone. Never the secret value — the
  // route layer bounds every string's length (note ≤280, evidence.ref ≤120)
  // and never logs any of them.
  ackEvidence: jsonb('ack_evidence').$type<{ kind?: string; ref?: string; note?: string } | null>(),
}, (table) => ({
  // Primary lookup: node checks for its own active grants on a given field.
  grantedToFieldIdx: index('idx_vault_delegation_granted_to_field')
    .on(table.grantedTo, table.field, table.status),
  // Subject lookup: owner lists / revokes their own grants.
  subjectIdx: index('idx_vault_delegation_subject')
    .on(table.subject, table.status),
  // Agent self-service lookup (#2231): a grantee enumerating its own grants,
  // optionally narrowed by purpose, without ever selecting the wrapped key.
  grantedToPurposeIdx: index('idx_vault_delegation_granted_to_purpose')
    .on(table.grantedTo, table.purpose),
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

  // The custody pair this request is asking the owner to sign (#1603).
  //
  // 0075 only ever needed the node's self-grant, where both values are the node's
  // own DID, so they were left implicit. Static-secret custody (#1439) uses
  // subject = principalDid and grantedTo = the connector app DID, and the grant
  // endpoint needs node-written state to check a returned grant against — the
  // request body cannot be trusted to name its own grantee.
  //
  // Nullable: rows written before #1603 predate the columns and are self-grants by
  // construction, so NULL is read as "the node's DID".
  //
  // `grantedTo` is an authorization label, NOT the ECDH recipient. The field key is
  // always wrapped to `nodeXPub`, because the node is what unseals on the grantee's
  // behalf at call time (see loadAndUnsealByGrantee).
  subject: text('subject'),
  grantedTo: text('granted_to'),
}, (table) => ({
  requestIdUniq: uniqueIndex('uniq_vault_grant_request_id').on(table.requestId),
  statusIdx: index('idx_vault_grant_requests_status').on(table.status),
  fieldStatusIdx: index('idx_vault_grant_requests_field_status').on(table.field, table.status),
  grantedToIdx: index('idx_vault_grant_requests_granted_to').on(table.grantedTo, table.status),
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

/**
 * Minted vault keys (#2242) — the bookkeeping record for an Ed25519 keypair
 * generated INSIDE the vault (never on disk, never returned by mint) and
 * sealed via the existing v2 delegation-grant custody path (#2231's
 * `sealAndGrantStaticSecret` / agent-fetch route). This table does not hold
 * any key material itself — the sealed private key lives in the ordinary
 * vault entry at `field`, and is reached only through a `vault_delegation_grants`
 * row (`grantId`), exactly like any other static secret.
 *
 * What this table adds on top of that existing machinery is the DID <->
 * mint provenance a delegation grant alone doesn't carry: who requested the
 * mint (`mintedBy`, the acting principal resolved via requireAuth/actingFor),
 * who the sealed key was delivered to (`requestedBy`, the grantee), and
 * revocation as a TOMBSTONE — `status`/`revokedAt`/`revokedBy` survive a
 * revoke so the record remembers a key existed and was revoked, distinct
 * from the delegation grant's own row (which `revokeMintedKey` still marks
 * 'revoked' and crypto-erases, per `revokeStaticSecretGrant`).
 *
 * Soft tombstone only for v1 (see apps/kernel/src/lib/vault/mint.ts): the
 * underlying vault entry at `field` is left in place, matching
 * `revokeStaticSecretGrant`'s existing "does not tombstone the vault entry"
 * contract. A harder-destroy tier (also wiping the vault entry itself) is
 * deferred — see the #2242 PR description.
 */
export const vaultMintedKeys = vaultSchema.table('vault_minted_keys', {
  id: text('id').primaryKey(),                          // vmk_{nanoid}
  did: text('did').notNull(),                            // the newly minted DID
  publicKey: text('public_key').notNull(),               // hex Ed25519 public key
  field: text('field').notNull(),                        // vault field holding the sealed private key
  purpose: text('purpose').notNull(),                    // free-form label — why this key was minted
  requestedBy: text('requested_by').notNull(),           // grantee DID the sealed key was delivered to
  mintedBy: text('minted_by').notNull(),                 // acting principal who called mint (requireAuth/actingFor)
  grantId: text('grant_id'),                             // vault_delegation_grants.id; null under Tier 1 pending grant
  status: text('status').notNull().default('active'),    // 'active' | 'revoked'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: text('revoked_by'),                         // acting principal who called revoke
}, (table) => ({
  didUniq: uniqueIndex('uniq_vault_minted_keys_did').on(table.did),
  fieldIdx: index('idx_vault_minted_keys_field').on(table.field),
  requestedByIdx: index('idx_vault_minted_keys_requested_by').on(table.requestedBy, table.status),
}));

export type VaultMintedKey = typeof vaultMintedKeys.$inferSelect;
export type NewVaultMintedKey = typeof vaultMintedKeys.$inferInsert;
