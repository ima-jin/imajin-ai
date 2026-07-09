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
  // Uniqueness: one active grant per (subject, grantedTo, field, keyId) tuple.
  // Rotation supersedes the previous grant before inserting a new one.
  activeGrantUniq: uniqueIndex('uniq_vault_delegation_active')
    .on(table.subject, table.grantedTo, table.field, table.keyId),
}));

export type VaultDelegationGrant = typeof vaultDelegationGrants.$inferSelect;
export type NewVaultDelegationGrant = typeof vaultDelegationGrants.$inferInsert;
