/**
 * Generic static-secret connector factory (#1437).
 *
 * Encapsulates the sealed-credential lifecycle for static API keys:
 *   1. Per-DID secret sealing (sealAndGrantStaticSecret — grantor = principal DID, grantee = app DID)
 *   2. Grant-gated unseal (loadAndUnsealByGrantee — fails closed on revoke/expiry/absence)
 *   3. Grant revocation (revokeStaticSecretGrant)
 *   4. Grant discovery (DB query by grantee + field prefix)
 *
 * The grant model (locked — Option B, 2026-07-26):
 *   - The *principal* (e.g. Catalyst/Chris) owns and seals the key.
 *   - The *grantee* (e.g. the AgriFortress app DID) is granted read access.
 *   - Revoking the grant makes all subsequent `loadSecret` calls fail closed.
 *   - The app DID is never the grantor; it is always the grantee.
 *
 * Usage:
 *   const connector = createConnectorStaticSecret({ name: 'gemini-key', secretPrefix: 'inference-model-key' });
 *   await connector.sealAndGrant(principalDid, appDid, apiKey);
 *   const key = await connector.loadSecret(appDid); // throws *_no_credential if no active grant
 *   await connector.revokeGrant(appDid, principalDid); // unseal now fails closed
 */

import { createLogger } from '@imajin/logger';
import { and, desc, eq, gt, isNull, like, or } from 'drizzle-orm';
import { db, vaultDelegationGrants } from '@/src/db';
import { sealAndGrantStaticSecret, loadAndUnsealByGrantee, revokeStaticSecretGrant } from '@/src/lib/vault';

const log = createLogger('kernel');

// ── Public types ──────────────────────────────────────────────────────────────

/** Options that parameterize the factory for a specific static-secret connector. */
export interface ConnectorStaticSecretOptions {
  /** Short connector name for error messages and log output, e.g. `'inference-model-key'`. */
  readonly name: string;
  /**
   * Vault field prefix for the per-principal secret.
   * The full vault field key is `${secretPrefix}:${principalDid}`.
   */
  readonly secretPrefix: string;
}

/** The object returned by `createConnectorStaticSecret`. */
export interface ConnectorStaticSecret {
  /** Vault field key for a given principal DID. */
  secretField(principalDid: string): string;
  /**
   * Seal a static secret on behalf of `principalDid` and issue a delegation
   * grant to `granteeDid`. Any previous active grant for the same
   * (principalDid, granteeDid, field) triple is superseded.
   */
  sealAndGrant(
    principalDid: string,
    granteeDid: string,
    secret: string,
    opts?: Readonly<{ expiresAt?: Date }>,
  ): Promise<{ grantId: string }>;
  /**
   * Unseal the secret for `granteeDid` (e.g. the vocabulary's app DID).
   * Fail-closed: throws `${name}_no_credential` when no active, non-expired
   * grant exists for this grantee, or when the vault entry is absent.
   */
  loadSecret(granteeDid: string): Promise<string>;
  /**
   * Revoke the active delegation grant for `granteeDid → principalDid`, making
   * all subsequent `loadSecret` calls fail closed. Safe to call when no active
   * grant exists (silently no-ops).
   */
  revokeGrant(granteeDid: string, principalDid: string): Promise<void>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createConnectorStaticSecret(
  opts: Readonly<ConnectorStaticSecretOptions>,
): ConnectorStaticSecret {

  function secretField(principalDid: string): string {
    return `${opts.secretPrefix}:${principalDid}`;
  }

  async function sealAndGrant(
    principalDid: string,
    granteeDid: string,
    secret: string,
    sealOpts: Readonly<{ expiresAt?: Date }> = {},
  ): Promise<{ grantId: string }> {
    const field = secretField(principalDid);
    const { grantId } = await sealAndGrantStaticSecret(field, secret, {
      principalDid,
      granteeDid,
      expiresAt: sealOpts.expiresAt ?? null,
    });
    log.info({ field, granteeDid }, `${opts.name}: secret sealed and delegation grant issued`);
    return { grantId };
  }

  async function loadSecret(granteeDid: string): Promise<string> {
    // Discover the most recent active grant for this grantee + field prefix.
    const rows = await db
      .select()
      .from(vaultDelegationGrants)
      .where(
        and(
          eq(vaultDelegationGrants.grantedTo, granteeDid),
          like(vaultDelegationGrants.field, `${opts.secretPrefix}:%`),
          eq(vaultDelegationGrants.status, 'active'),
          or(
            isNull(vaultDelegationGrants.expiresAt),
            gt(vaultDelegationGrants.expiresAt, new Date()),
          ),
        ),
      )
      .orderBy(desc(vaultDelegationGrants.createdAt))
      .limit(1);

    if (rows.length === 0) {
      throw new Error(
        `${opts.name}_no_credential: no active delegation grant for grantee ${granteeDid} (prefix=${opts.secretPrefix})`,
      );
    }

    return loadAndUnsealByGrantee(rows[0].field, granteeDid);
  }

  async function revokeGrant(granteeDid: string, principalDid: string): Promise<void> {
    const field = secretField(principalDid);
    await revokeStaticSecretGrant(field, granteeDid);
    log.info({ field, granteeDid }, `${opts.name}: delegation grant revoked`);
  }

  return { secretField, sealAndGrant, loadSecret, revokeGrant };
}

// ── Pre-configured instance for inference model keys ──────────────────────────

/**
 * Pre-configured connector for inference engine model API keys (#1437).
 *
 * Vault field: `inference-model-key:${principalDid}`
 * Grantee: the vocabulary's owning app DID (e.g. `did:imajin:agrifortress`)
 * Grantor: the principal who owns the API key (e.g. `did:catalyst:chris`)
 */
export const inferenceModelKeyConnector = createConnectorStaticSecret({
  name: 'inference-model-key',
  secretPrefix: 'inference-model-key',
});
