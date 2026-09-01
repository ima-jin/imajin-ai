import { pgSchema, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Connector registry (#1924, Phase 1 of #1922).
 *
 * One row per `(owner_did, provider)` connector installation. Before this,
 * connector state had no single home: scopes lived in `auth.channel_links`,
 * the wrapped field key in `kernel.vault_delegation_grants`, the ciphertext in
 * the file vault, and the catalogue of supported connectors in the static
 * `CONNECTOR_REGISTRY`. Nothing joined them, so a spend cap or a lease TTL had
 * nowhere to live at all.
 *
 * ## Shadow, not replacement
 * `auth.channel_links` remains AUTHORITATIVE for grant checks and
 * `kernel.vault_delegation_grants` remains AUTHORITATIVE for custody — see the
 * decision note at the top of `migrations/0114_connectors_registry.sql`. This
 * table is written alongside them (connect, disconnect, scope publish) and is
 * the home for the two facts that previously had none: `spendCap` and
 * `expiresAt`.
 *
 * ## Custody
 * `sealedKeyField` is a vault FIELD NAME, e.g. `xai-api-key:did:imajin:…`. It
 * is a reference, not a credential: no ciphertext, no wrapped key, no
 * plaintext ever lands here, and reading a row grants nothing. The sealed key
 * still never leaves the kernel and there is still no raw-key release path.
 */
export const connectorsSchema = pgSchema('kernel');

export const connectors = connectorsSchema.table('connectors', {
  /** `conn_{sha256(owner|provider)[0..24]}` — deterministic, so a re-run of the backfill collides rather than duplicating. */
  id: text('id').primaryKey(),
  /** DID whose connector this is. Consent and attribution stay attached here. */
  ownerDid: text('owner_did').notNull(),
  /** `CONNECTOR_REGISTRY` id, e.g. `'gemini'` | `'anthropic'` | `'xai'`. */
  provider: text('provider').notNull(),
  /** Channel label used in `auth.channel_links.channel`. Conventionally equals `provider`. */
  channel: text('channel').notNull(),
  /** Connector app DID used in `auth.channel_links.app_did`. */
  connectorDid: text('connector_did').notNull(),
  /**
   * Vault field name holding the sealed credential, or null for a connector
   * with no single per-DID credential (the native MCP connector). A reference
   * only — never key material.
   */
  sealedKeyField: text('sealed_key_field'),
  /**
   * Snapshot of the scopes granted on this connector, refreshed whenever the
   * owner publishes a scope-manifest. `auth.channel_links` stays authoritative:
   * anything that gates access reads there, not here.
   */
  scopes: jsonb('scopes').notNull().default(sql`'[]'::jsonb`),
  /**
   * Declared spend ceiling, enforced kernel-side by the Phase 3 passthrough.
   * Shapeless on purpose until #1922 Phase 3 settles the window semantics.
   */
  spendCap: jsonb('spend_cap'),
  /**
   * Lease end. Compared at read time — `status` only ever moves
   * `active -> revoked`, and renewal bumps this in place. Mirrors the
   * convention in `vault_delegation_grants` (0063) and `delegation_grants`
   * (0099); a swept status that claims `active` past its expiry is the exact
   * failure both were written to avoid.
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  status: text('status').notNull().default('active'),   // 'active' | 'revoked'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  /** Dashboard read: every connector this DID has. */
  ownerIdx: index('idx_connectors_owner').on(table.ownerDid, table.status),
  /** Operator read: who is on a given provider. */
  providerIdx: index('idx_connectors_provider').on(table.provider, table.status),
  /** Lease-expiry observability. */
  expiresIdx: index('idx_connectors_expires')
    .on(table.expiresAt)
    .where(sql`${table.expiresAt} IS NOT NULL AND ${table.status} = 'active'`),
  /** Resolve a sealed field back to its owning connector without a scan. */
  sealedKeyFieldIdx: index('idx_connectors_sealed_key_field')
    .on(table.sealedKeyField)
    .where(sql`${table.sealedKeyField} IS NOT NULL`),
  /** One registration per (owner, provider) — the upsert target. */
  ownerProviderUniq: uniqueIndex('uniq_connectors_owner_provider')
    .on(table.ownerDid, table.provider),
}));

export type ConnectorRow = typeof connectors.$inferSelect;
export type NewConnectorRow = typeof connectors.$inferInsert;
