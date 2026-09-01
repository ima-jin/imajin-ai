/**
 * Connector registry store (#1924, Phase 1 of #1922).
 *
 * Read/write surface for `kernel.connectors` — the consolidated per-DID
 * connector registry created by `migrations/0114_connectors_registry.sql`.
 *
 * ## What this is, and is not
 * The registry SHADOWS the existing spread; it does not replace it:
 *   - `auth.channel_links` stays authoritative for grant checks. Every
 *     connector's fail-closed gate reads it, unchanged.
 *   - `kernel.vault_delegation_grants` + the vault stay authoritative for
 *     custody. This module stores the vault FIELD NAME only — a reference, not
 *     a credential. No ciphertext, no wrapped key, no plaintext is written or
 *     returned here, and nothing in this module can unseal anything.
 *
 * ## Fail-open, deliberately
 * Every write is wrapped and logged rather than thrown. The registry is a
 * projection: a failed write must never turn a successful key seal into a 500,
 * or a disconnect into a credential the owner believes is revoked but is not.
 * The authoritative rows (`channel_links`, `vault_delegation_grants`) are
 * written by the caller either way, and the next connect/disconnect/publish
 * re-converges this table.
 *
 * IMPORTANT: this module is server-only (DB access). `connector-registry.ts`
 * — the static catalogue it reads connector identity from — is client-safe and
 * stays that way; the dependency runs in this direction only.
 */
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import { db, connectors, type ConnectorRow } from '@/src/db';
import { getConnector } from './connector-registry';

const log = createLogger('kernel');

/**
 * Deterministic row id, matching the expression the 0114 backfill uses.
 *
 * Deterministic rather than random so the backfill and the application cannot
 * write two rows for the same installation: both land on the same primary key
 * and the unique `(owner_did, provider)` index, whichever runs first.
 */
export function connectorRegistryId(ownerDid: string, provider: string): string {
  const digest = createHash('sha256').update(`${ownerDid}|${provider}`).digest('hex');
  return `conn_${digest.slice(0, 24)}`;
}

/** What a caller needs to identify one connector installation. */
export interface ConnectorRegistration {
  ownerDid: string;
  /** `CONNECTOR_REGISTRY` id, e.g. `'xai'`. */
  provider: string;
  /**
   * Vault field name of the sealed credential, e.g. `xai-api-key:did:…`.
   * Omitted for connectors that seal nothing (the native MCP connector).
   */
  sealedKeyField?: string;
}

/**
 * Connector identity as the static catalogue declares it.
 *
 * Resolved from `CONNECTOR_REGISTRY` rather than passed in, so a registry row
 * can never claim a channel or connector DID that the platform does not
 * actually serve — the drift that #1253 exists to prevent, in a new table.
 */
function connectorIdentity(provider: string): { channel: string; connectorDid: string } | undefined {
  const entry = getConnector(provider);
  if (!entry) return undefined;
  return { channel: entry.channel, connectorDid: entry.connectorDid };
}

/**
 * Record (or refresh) a connector installation for this owner.
 *
 * Called after a credential is sealed. Deliberately does NOT touch `scopes`:
 * at seal time the owner has usually not reached the "grant scopes" step yet,
 * and overwriting a live snapshot with `[]` would make the registry look like
 * a revocation. {@link syncConnectorRegistrationScopes} owns that column.
 *
 * Re-sealing an already-registered connector re-activates it, which is the
 * right reading of "the owner just pasted a key again".
 */
export async function recordConnectorRegistration(reg: ConnectorRegistration): Promise<void> {
  const identity = connectorIdentity(reg.provider);
  if (!identity) {
    log.warn({ provider: reg.provider }, 'connector registry: unknown provider — skipping registration');
    return;
  }

  const now = new Date();
  try {
    await db
      .insert(connectors)
      .values({
        id: connectorRegistryId(reg.ownerDid, reg.provider),
        ownerDid: reg.ownerDid,
        provider: reg.provider,
        channel: identity.channel,
        connectorDid: identity.connectorDid,
        sealedKeyField: reg.sealedKeyField ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: [connectors.ownerDid, connectors.provider],
        set: {
          channel: identity.channel,
          connectorDid: identity.connectorDid,
          sealedKeyField: reg.sealedKeyField ?? null,
          status: 'active',
          updatedAt: now,
          revokedAt: null,
        },
      });
  } catch (err) {
    log.warn(
      { err: String(err), ownerDid: reg.ownerDid, provider: reg.provider },
      'connector registry: failed to record registration — channel_links and vault grants are unaffected',
    );
  }
}

/**
 * Mark a connector installation revoked.
 *
 * Called after the sealed key's delegation grant and the connector's
 * `channel_links` rows have been revoked, so the registry agrees with the two
 * authoritative surfaces. The row is kept (not deleted) — a revoked connector
 * is still the place a spend cap and a lease live, and re-pasting the key
 * re-activates the same row.
 */
export async function revokeConnectorRegistration(ownerDid: string, provider: string): Promise<void> {
  const now = new Date();
  try {
    await db
      .update(connectors)
      .set({ status: 'revoked', scopes: [], revokedAt: now, updatedAt: now })
      .where(and(eq(connectors.ownerDid, ownerDid), eq(connectors.provider, provider)));
  } catch (err) {
    log.warn(
      { err: String(err), ownerDid, provider },
      'connector registry: failed to record revocation — the credential grant IS revoked',
    );
  }
}

/**
 * Refresh the scope snapshot for one connector installation.
 *
 * Called after a scope-manifest publish, with the scopes that were actually
 * requested. Creates the row when the owner granted scopes before sealing a
 * credential (OAuth and native connectors have no seal step at all), which is
 * why this upserts rather than updates.
 */
export async function syncConnectorRegistrationScopes(
  ownerDid: string,
  provider: string,
  scopes: readonly string[],
): Promise<void> {
  const identity = connectorIdentity(provider);
  if (!identity) {
    log.warn({ provider }, 'connector registry: unknown provider — skipping scope sync');
    return;
  }

  const now = new Date();
  const snapshot = [...scopes];
  try {
    await db
      .insert(connectors)
      .values({
        id: connectorRegistryId(ownerDid, provider),
        ownerDid,
        provider,
        channel: identity.channel,
        connectorDid: identity.connectorDid,
        scopes: snapshot,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectors.ownerDid, connectors.provider],
        set: { scopes: snapshot, updatedAt: now },
      });
  } catch (err) {
    log.warn(
      { err: String(err), ownerDid, provider },
      'connector registry: failed to sync scope snapshot — channel_links is authoritative and was written',
    );
  }
}

/**
 * Every registered connector for this owner, active and revoked alike.
 *
 * A read of the registry only: callers that need to know whether a scope is
 * currently granted must still ask `auth.channel_links` during the shadow
 * period. Fail-closed on error — unlike the writes, a read that silently
 * answers "no connectors" would be indistinguishable from the truth.
 */
export function listConnectorRegistrations(ownerDid: string): Promise<ConnectorRow[]> {
  return db.select().from(connectors).where(eq(connectors.ownerDid, ownerDid));
}

/** One registered connector, or undefined when this owner has never had it. */
export async function readConnectorRegistration(
  ownerDid: string,
  provider: string,
): Promise<ConnectorRow | undefined> {
  const rows = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.ownerDid, ownerDid), eq(connectors.provider, provider)))
    .limit(1);
  return rows[0];
}
