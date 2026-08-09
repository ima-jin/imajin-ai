/**
 * Generic token-paste connector factory (#1621).
 *
 * The third ingestion pattern to get a factory, alongside `createConnectorOAuth`
 * (#1333) and `createConnectorStaticSecret` (#1439). Token-paste connectors —
 * the ones where the owner pastes a provider API key — had been hand-copied per
 * provider. Adding the Anthropic brain made that a third copy, so the shape is
 * now declared once here.
 *
 * Custody model (mirrors the Gemini connector it was extracted from):
 * - Fail-closed on every gate: no active grant OR no sealed key ⇒ throw.
 * - The key is NEVER logged, NEVER returned to callers, NEVER echoed.
 * - Per-DID vault field isolation: `${keyPrefix}:${ownerDid}`. Encoding the DID
 *   in the field name makes cross-DID reads structurally impossible rather than
 *   merely checked.
 *
 * Optional `baseUrl` and `modelId` live in sibling fields so a per-DID endpoint
 * and model override can be sealed alongside the key. A sealed `modelId` is how
 * the owner chooses which model runs — sealing a key IS choosing your brain.
 *
 * ## Two custody classes, not one (#1637)
 * All three fields used to go through `sealAndStoreV2`, i.e.
 * `custodyScheme: 'delegation-grant'`. That is right for the API key and wrong
 * for the other two.
 *
 * - `${id}-api-key:{did}` — **v2, delegation-grant.** Authority-bearing secret
 *   material: revoking the grant crypto-erases the wrapped field key, so access
 *   dies immediately without rotating the key upstream. Worth the machinery.
 * - `${id}-base-url:{did}` and `${id}-model-id:{did}` — **v1, node-sealed.**
 *   An endpoint and a model name are neither secret nor authority-bearing;
 *   nothing is protected by making `gemini-2.0-flash` revocable. Under Tier 1
 *   (#1603) delegation-grant custody costs an out-of-band owner-approval round
 *   trip before the value is readable at all, so a sealed model override would
 *   silently not apply — inference would quietly run the connector default —
 *   for as long as approval took. Same reasoning, same conclusion as
 *   `../warp/environment.ts` (#1632); these fields simply predate it.
 *
 * ## Migration of already-sealed v2 config fields
 * Read-compatible rather than migrated. `loadAndUnseal` dispatches on the stored
 * entry's own `custodyScheme`, so a pre-#1637 v2 `-base-url` / `-model-id` entry
 * keeps resolving wherever its grant is active (every Tier 0 node), and an
 * unreadable one is reported as "no override" instead of taking the connector
 * down (see {@link loadOptionalConfig}). The next write through `sealApiKey`
 * lands as v1 and the anomaly is gone. These are recoverable non-secrets — a
 * value the owner can re-type on the connector card — so spending a
 * `migrate-custody` pass and a Tier 1 grant round trip per field to preserve
 * them was not worth it.
 */
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, channelLinks } from '@/src/db';
import {
  sealAndStore,
  sealAndStoreV2,
  loadAndUnseal,
  vaultFieldStatus,
  revokeVaultDelegationGrantsForConnector,
} from '@/src/lib/vault';
import { VaultDelegationError } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/** Options that parameterize the factory for one provider. */
export interface ConnectorTokenPasteOptions {
  /**
   * Lowercase connector id, e.g. `'gemini'`. Used for the vault field prefix and
   * as the machine-readable error prefix (`${id}_no_grant`), so changing it is a
   * breaking change to both stored fields and error contracts.
   */
  id: string;
  /** Display name used in human-facing error prose, e.g. `'Gemini'`. */
  displayName: string;
  /** Connector app DID that appears in `auth.channel_links.appDid`. */
  connectorDid: string;
  /** Channel label in `auth.channel_links.channel`. Conventionally equals `id`. */
  channel: string;
}

/** Credentials resolved for one DID. The key must not outlive the calling scope. */
export interface TokenPasteCredentials {
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
}

export interface ConnectorTokenPaste {
  /** Vault field holding the per-DID API key. */
  vaultField(ownerDid: string): string;
  /**
   * Seal an API key, and optionally a base URL and model id, for this DID.
   * Re-sealing replaces the previous values (rotate semantics). The plaintext is
   * never logged or returned; a successful vault write is the only output.
   *
   * An omitted `baseUrl` / `modelId` leaves any previously sealed value in
   * place; it is deliberately NOT a clear. The connector card posts only the
   * pasted key, so treating omission as "delete" would silently drop the
   * owner's model choice every time they rotated a key.
   */
  sealApiKey(ownerDid: string, apiKey: string, baseUrl?: string, modelId?: string): Promise<void>;
  /**
   * True only when an ACTIVE `channel_links` row for this connector + DID carries
   * the requested scope. Fail-closed: DB errors propagate.
   */
  resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean>;
  /**
   * Resolve sealed credentials, or `undefined` when this DID has no usable
   * connection — including one whose key is sealed but still awaiting the owner
   * agent's grant (#1603).
   *
   * Returning `undefined` rather than throwing is what lets a resolver try the
   * next provider; use `requireGrantAndKey` where the grant is mandatory and the
   * pending state must be named.
   */
  loadCredentials(ownerDid: string, scope: string): Promise<TokenPasteCredentials | undefined>;
  /**
   * Fail-closed gate returning the key.
   *
   * Throws `${id}_no_grant`, `${id}_no_key`, or `${id}_credential_pending`
   * (sealed but awaiting the owner agent's grant, #1603).
   */
  requireGrantAndKey(ownerDid: string, scope: string): Promise<string>;
  /**
   * Whether a key is sealed AND readable for this DID — an active delegation
   * grant covers it, not merely a vault entry existing (#1724).
   *
   * `revokeApiKey` (disconnect) deliberately leaves the sealed vault entry in
   * place and only revokes the grant, so checking entry existence alone would
   * report a disconnected key as still sealed forever — the exact bug this
   * fixes. No crypto, no value returned.
   */
  keySealed(ownerDid: string): Promise<boolean>;
  /**
   * Whether a key is sealed but still awaiting owner grant approval.
   *
   * Distinct from `keySealed`, which reports `false` in this state because the
   * value cannot yet be read — a surface needs both to tell "not connected" from
   * "waiting for owner approval".
   */
  keyPending(ownerDid: string): Promise<boolean>;
  /**
   * Revoke the sealed API key's delegation grant for this DID, cutting off
   * access immediately (#1720). Mirrors the static-secret connector's revoke
   * semantics (`connector-static-secret.ts`): the underlying vault entry is
   * NOT deleted, only the grant that makes it readable — the owner can still
   * re-paste the same key to restore access without losing the sealed copy.
   *
   * Returns true when at least one active grant was revoked.
   */
  revokeApiKey(ownerDid: string): Promise<boolean>;
}

export function createConnectorTokenPaste(
  opts: ConnectorTokenPasteOptions,
): ConnectorTokenPaste {
  const keyField = (ownerDid: string) => `${opts.id}-api-key:${ownerDid}`;
  const baseUrlField = (ownerDid: string) => `${opts.id}-base-url:${ownerDid}`;
  const modelIdField = (ownerDid: string) => `${opts.id}-model-id:${ownerDid}`;

  /**
   * Read a non-secret config field, treating any failure as "not set".
   *
   * Never throws. A model name or endpoint override must not be able to take
   * down a connector whose key is perfectly good: the two cases that get here
   * are a pre-#1637 v2 entry with no active grant (Tier 1 pending, or a lapsed
   * grant) and a corrupt entry, and for both the honest answer is "there is no
   * usable override", which degrades to the connector default. The failure is
   * logged so it stays visible rather than silently swallowed.
   *
   * Same shape, and the same reasoning, as `readEnvironmentId` in
   * `../warp/environment.ts` (#1632).
   */
  async function loadOptionalConfig(field: string): Promise<string | undefined> {
    try {
      return await loadAndUnseal(field);
    } catch (err) {
      log.warn(
        { err: String(err), field, connector: opts.id },
        `${opts.displayName} connector config field unreadable — treating as unset`,
      );
      return undefined;
    }
  }

  async function sealApiKey(
    ownerDid: string,
    apiKey: string,
    baseUrl?: string,
    modelId?: string,
  ): Promise<void> {
    // The key is the only secret here, so it is the only field that earns
    // delegation-grant custody (#1637).
    await sealAndStoreV2(keyField(ownerDid), apiKey);
    if (baseUrl) {
      await sealAndStore(baseUrlField(ownerDid), baseUrl);
    }
    if (modelId) {
      await sealAndStore(modelIdField(ownerDid), modelId);
    }
  }

  async function resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean> {
    const rows = await db
      .select({ scopes: channelLinks.scopes })
      .from(channelLinks)
      .where(
        and(
          eq(channelLinks.channel, opts.channel),
          eq(channelLinks.did, ownerDid),
          eq(channelLinks.appDid, opts.connectorDid),
          eq(channelLinks.status, 'active'),
        ),
      );

    return rows.some((row: { scopes: unknown }) => {
      const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
      return scopes.includes(requiredScope);
    });
  }

  async function loadCredentials(
    ownerDid: string,
    scope: string,
  ): Promise<TokenPasteCredentials | undefined> {
    const hasGrant = await resolveActiveGrant(ownerDid, scope);
    if (!hasGrant) {
      return undefined;
    }

    // A v2 key with no active grant throws VaultDelegationError. That is a
    // legitimate, expected state under Tier 1 — sealed, awaiting owner approval
    // — and this function is documented to answer `undefined` for "no usable
    // connection" so a resolver can try the next provider. Letting the throw
    // escape meant one pending key took every later connector down with it
    // (#1637). `requireGrantAndKey` is where the state gets a name.
    let apiKey: string | undefined;
    try {
      apiKey = await loadAndUnseal(keyField(ownerDid));
    } catch (err) {
      if (err instanceof VaultDelegationError) {
        log.warn(
          { connector: opts.id, ownerDid },
          `${opts.displayName} API key is sealed but awaiting owner grant approval — treating this DID as unconnected`,
        );
        return undefined;
      }
      throw err;
    }
    if (apiKey === undefined) {
      return undefined;
    }

    const [baseUrl, modelId] = await Promise.all([
      loadOptionalConfig(baseUrlField(ownerDid)),
      loadOptionalConfig(modelIdField(ownerDid)),
    ]);

    return {
      apiKey,
      ...(baseUrl !== undefined && { baseUrl }),
      ...(modelId !== undefined && { modelId }),
    };
  }

  async function requireGrantAndKey(ownerDid: string, scope: string): Promise<string> {
    const hasGrant = await resolveActiveGrant(ownerDid, scope);
    if (!hasGrant) {
      throw new Error(
        `${opts.id}_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
        `use the ${opts.displayName} connector to seal your API key and enable this scope`,
      );
    }

    let key: string | undefined;
    try {
      key = await loadAndUnseal(keyField(ownerDid));
    } catch (err) {
      if (err instanceof VaultDelegationError) {
        throw new Error(
          `${opts.id}_credential_pending: ${opts.displayName} API key for DID ${ownerDid} is sealed but awaiting owner grant approval`,
        );
      }
      throw err;
    }
    if (key === undefined) {
      throw new Error(
        `${opts.id}_no_key: no ${opts.displayName} API key sealed for DID ${ownerDid} — ` +
        `use the ${opts.displayName} connector token route to store a key first`,
      );
    }

    return key;
  }

  async function revokeApiKey(ownerDid: string): Promise<boolean> {
    const revokedCount = await revokeVaultDelegationGrantsForConnector(opts.id, ownerDid);
    return revokedCount > 0;
  }

  /**
   * `keySealed` used to be `vaultFieldExists(keyField(ownerDid))`, which only
   * checks that a vault entry exists and verifies — it says nothing about
   * whether a grant currently covers it. `revokeApiKey` revokes the grant but
   * intentionally does NOT delete the entry, so a disconnected key kept
   * reporting `keySealed: true` forever (#1724): the UI showed "API Key
   * sealed" with no way to disconnect again (nothing left to revoke) or
   * re-paste (the form was hidden behind the stale sealed state).
   *
   * `vaultFieldStatus` already answers the right question — 'ready' means a
   * v1 entry, or a v2 entry with an ACTIVE, non-expired grant (it filters
   * `WHERE status = 'active'`, see `field-status.ts`). Reusing it here keeps
   * `keySealed` and `keyPending` mutually exclusive and consistent, and needs
   * no vault-layer change.
   */
  async function keySealed(ownerDid: string): Promise<boolean> {
    return (await vaultFieldStatus(keyField(ownerDid))) === 'ready';
  }

  return {
    vaultField: keyField,
    sealApiKey,
    resolveActiveGrant,
    loadCredentials,
    requireGrantAndKey,
    keySealed,
    keyPending: async (ownerDid: string) =>
      (await vaultFieldStatus(keyField(ownerDid))) === 'pending-grant',
    revokeApiKey,
  };
}
