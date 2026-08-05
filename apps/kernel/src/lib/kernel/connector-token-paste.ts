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
 */
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { sealAndStoreV2, loadAndUnseal, vaultFieldExists, vaultFieldStatus } from '@/src/lib/vault';
import { VaultDelegationError } from '@/src/lib/vault/errors';

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
   */
  sealApiKey(ownerDid: string, apiKey: string, baseUrl?: string, modelId?: string): Promise<void>;
  /**
   * True only when an ACTIVE `channel_links` row for this connector + DID carries
   * the requested scope. Fail-closed: DB errors propagate.
   */
  resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean>;
  /**
   * Resolve sealed credentials, or `undefined` when this DID has no connection.
   *
   * Returning `undefined` rather than throwing is what lets a resolver try the
   * next provider; use `requireGrantAndKey` where the grant is mandatory.
   */
  loadCredentials(ownerDid: string, scope: string): Promise<TokenPasteCredentials | undefined>;
  /**
   * Fail-closed gate returning the key.
   *
   * Throws `${id}_no_grant`, `${id}_no_key`, or `${id}_credential_pending`
   * (sealed but awaiting the owner agent's grant, #1603).
   */
  requireGrantAndKey(ownerDid: string, scope: string): Promise<string>;
  /** Whether a key is sealed for this DID. No crypto, no value returned. */
  keySealed(ownerDid: string): Promise<boolean>;
  /**
   * Whether a key is sealed but still awaiting owner grant approval.
   *
   * Distinct from `keySealed`, which reports `false` in this state because the
   * value cannot yet be read — a surface needs both to tell "not connected" from
   * "waiting for owner approval".
   */
  keyPending(ownerDid: string): Promise<boolean>;
}

export function createConnectorTokenPaste(
  opts: ConnectorTokenPasteOptions,
): ConnectorTokenPaste {
  const keyField = (ownerDid: string) => `${opts.id}-api-key:${ownerDid}`;
  const baseUrlField = (ownerDid: string) => `${opts.id}-base-url:${ownerDid}`;
  const modelIdField = (ownerDid: string) => `${opts.id}-model-id:${ownerDid}`;

  async function sealApiKey(
    ownerDid: string,
    apiKey: string,
    baseUrl?: string,
    modelId?: string,
  ): Promise<void> {
    await sealAndStoreV2(keyField(ownerDid), apiKey);
    if (baseUrl) {
      await sealAndStoreV2(baseUrlField(ownerDid), baseUrl);
    }
    if (modelId) {
      await sealAndStoreV2(modelIdField(ownerDid), modelId);
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

    const apiKey = await loadAndUnseal(keyField(ownerDid));
    if (apiKey === undefined) {
      return undefined;
    }

    const [baseUrl, modelId] = await Promise.all([
      loadAndUnseal(baseUrlField(ownerDid)),
      loadAndUnseal(modelIdField(ownerDid)),
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

  return {
    vaultField: keyField,
    sealApiKey,
    resolveActiveGrant,
    loadCredentials,
    requireGrantAndKey,
    keySealed: (ownerDid: string) => vaultFieldExists(keyField(ownerDid)),
    keyPending: async (ownerDid: string) =>
      (await vaultFieldStatus(keyField(ownerDid))) === 'pending-grant',
  };
}
