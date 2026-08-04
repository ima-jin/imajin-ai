/**
 * Generic static-secret connector factory (#1439).
 *
 * Encapsulates the vault + grant boilerplate for connectors that use static
 * API keys (not OAuth tokens). Parallel to createConnectorOAuth (#1333).
 *
 * Custody model (Option B — principal-delegates-to-app):
 *   - The **principal DID** (e.g. the human who owns the API key) seals the
 *     secret and mints a delegation grant to the connector app DID.
 *   - The **connector DID** (grantee) can unseal the key at call time.
 *   - Revoking the grant → all future unseals fail closed immediately.
 *
 * Usage:
 *   const connector = createConnectorStaticSecret({ name: 'gemini', ... });
 *   export const secretField    = connector.secretField;
 *   export const requireSecret  = connector.requireSecret;
 *   // … etc.
 *
 * Provider-specific API actions stay in the connector module; this factory
 * only handles credential storage and retrieval.
 */
import { createLogger } from '@imajin/logger';
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import {
  sealAndGrantStaticSecret,
  loadAndUnsealByGrantee,
  revokeStaticSecretGrant,
  vaultFieldExists,
  vaultFieldStatusForGrantee,
} from '@/src/lib/vault';

const log = createLogger('kernel');

// ── Public types ──────────────────────────────────────────────────────────────

/** Options that parameterize the factory for a specific static-secret provider. */
export interface ConnectorStaticSecretOptions {
  /**
   * Short connector name used in error messages and log output,
   * e.g. `'gemini'`, `'openai'`.
   */
  name: string;
  /**
   * Vault key prefix for the per-DID sealed secret,
   * e.g. `'gemini-api-key'`. The full key is `${secretPrefix}:${principalDid}`.
   */
  secretPrefix: string;
  /** Connector app DID that acts as the grantee, e.g. `'did:imajin:gemini-connector'`. */
  connectorDid: string;
  /** Channel name in `auth.channel_links`, e.g. `'gemini'`. */
  channel: string;
}

/** The object returned by `createConnectorStaticSecret`. */
export interface ConnectorStaticSecret {
  /** Vault key for the per-principal sealed secret. */
  secretField(principalDid: string): string;
  /**
   * Seal a plaintext secret for the principal and mint a delegation grant to
   * the connector DID. Re-calling supersedes the previous grant (rotate
   * semantics). The plaintext is never logged or returned.
   *
   * Under Tier 1 the node cannot mint the grant itself, so `grantId` is `null`
   * and `requestId` identifies the request queued for the external owner agent
   * (#1603). That is a successful seal with a pending authorization — the secret
   * is stored, but `requireSecret` fails closed until the owner answers.
   */
  sealAndGrant(
    principalDid: string,
    plaintext: string,
    opts?: { expiresAt?: Date | null },
  ): Promise<{ grantId: string | null; requestId: string | null }>;
  /**
   * Load the sealed secret for principalDid via the connector's delegation
   * grant. Returns `undefined` when no grant exists or no secret is sealed.
   * Use `requireSecret` for the fail-closed gate.
   */
  loadSecret(principalDid: string): Promise<string | undefined>;
  /**
   * Fail-closed gate: checks an active channel_links scope then unseals.
   *
   * Throws:
   *   - `${name}_no_grant`   — no active channel_links row for scope.
   *   - `${name}_no_secret`  — no sealed secret / delegation grant.
   */
  requireSecret(principalDid: string, scope: string): Promise<string>;
  /**
   * Revoke the delegation grant for principalDid → connectorDid.
   * Returns `true` when a grant was deactivated, `false` if none existed.
   */
  revokeGrant(principalDid: string): Promise<boolean>;
  /** Check whether a secret is sealed for principalDid (no crypto). */
  secretSealed(principalDid: string): Promise<boolean>;
  /**
   * Whether a secret is sealed but still awaiting the owner agent's grant
   * (Tier 1, #1603).
   *
   * Distinct from `secretSealed`, which reports `false` for this state because the
   * value cannot yet be read. A connector surface needs both to tell "not
   * connected" apart from "waiting for owner approval".
   */
  secretPending(principalDid: string): Promise<boolean>;
  /**
   * Resolve whether an ACTIVE channel_links row for ownerDid + scope exists.
   * Fail-closed: DB errors propagate.
   */
  resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createConnectorStaticSecret(
  opts: ConnectorStaticSecretOptions,
): ConnectorStaticSecret {

  function secretField(principalDid: string): string {
    return `${opts.secretPrefix}:${principalDid}`;
  }

  async function sealAndGrant(
    principalDid: string,
    plaintext: string,
    { expiresAt }: { expiresAt?: Date | null } = {},
  ): Promise<{ grantId: string | null; requestId: string | null }> {
    const { grantId, requestId } = await sealAndGrantStaticSecret(
      secretField(principalDid),
      plaintext,
      { principalDid, granteeDid: opts.connectorDid, expiresAt: expiresAt ?? null },
    );
    log.info(
      { principalDid, connectorDid: opts.connectorDid, pendingGrant: grantId === null },
      `${opts.name} static secret sealed`,
    );
    return { grantId, requestId };
  }

  async function loadSecret(principalDid: string): Promise<string | undefined> {
    return loadAndUnsealByGrantee(secretField(principalDid), opts.connectorDid);
  }

  async function requireSecret(principalDid: string, scope: string): Promise<string> {
    const hasGrant = await resolveActiveGrant(principalDid, scope);
    if (!hasGrant) {
      throw new Error(
        `${opts.name}_no_grant: DID ${principalDid} has no active '${scope}' grant — ` +
        `use the ${opts.name} connector to seal your API key and enable this scope`,
      );
    }

    const secret = await loadAndUnsealByGrantee(secretField(principalDid), opts.connectorDid);
    if (secret === undefined) {
      throw new Error(
        `${opts.name}_no_secret: no ${opts.name} secret sealed for DID ${principalDid} — ` +
        `use the ${opts.name} connector seal route to store a secret first`,
      );
    }

    return secret;
  }

  async function revokeGrant(principalDid: string): Promise<boolean> {
    return revokeStaticSecretGrant(secretField(principalDid), opts.connectorDid);
  }

  function secretSealed(principalDid: string): Promise<boolean> {
    return vaultFieldExists(secretField(principalDid));
  }

  async function secretPending(principalDid: string): Promise<boolean> {
    const status = await vaultFieldStatusForGrantee(
      secretField(principalDid),
      opts.connectorDid,
    );
    return status === 'pending-grant';
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

  return {
    secretField,
    sealAndGrant,
    loadSecret,
    requireSecret,
    revokeGrant,
    secretSealed,
    secretPending,
    resolveActiveGrant,
  };
}
