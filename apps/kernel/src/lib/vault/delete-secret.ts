/**
 * Operator delete of a sealed vault field (#2698).
 *
 * Deleting a field tombstones its vault entry AND must leave no active
 * delegation grant pointing at the tombstone. Both happen in ONE database
 * transaction:
 *   1. revoke every active grant on the field (the node's own self-grant
 *      included — there is nothing left for it to cover);
 *   2. erase those grants' wrapped key material (same semantics as every other
 *      revoke in the vault);
 *   3. write the signed tombstone.
 *
 * The tombstone is a file write that no rollback can undo, so it is the LAST
 * step inside the transaction (same ordering rule as the atomic re-seal,
 * #2451): if it throws, the callback rejects, the transaction rolls back and
 * the grants are still active; if an earlier step throws, nothing was
 * tombstoned. No plaintext is read or logged at any point.
 */
import { and, eq } from 'drizzle-orm';
import type { VaultEntry } from '@imajin/vault-core';
import { db, vaultDelegationGrants } from '@/src/db';
import { deleteFromVault, eraseInactiveGrantKeyMaterial } from './index';

export interface DeleteSecretResult {
  /** The signed tombstone entry that now heads the field's chain. */
  tombstone: VaultEntry;
  /** `grantedTo` DIDs of the grants revoked by this delete, in revoke order. */
  revokedGrantees: string[];
}

/** Internal signal: the field vanished between the route's existence check and the tombstone. */
class NothingToDeleteError extends Error {
  constructor(field: string) {
    super(`vault delete: no entry for field '${field}'`);
    this.name = 'NothingToDeleteError';
  }
}

/**
 * Tombstone `field` and revoke its active grants atomically.
 * Returns `undefined` — having changed nothing — when the field has no vault entry.
 */
export async function deleteSecretAndRevokeGrants(field: string): Promise<DeleteSecretResult | undefined> {
  try {
    return await db.transaction(async (tx) => {
      const revoked = await tx
        .update(vaultDelegationGrants)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(and(eq(vaultDelegationGrants.field, field), eq(vaultDelegationGrants.status, 'active')))
        .returning({
          id: vaultDelegationGrants.id,
          field: vaultDelegationGrants.field,
          keyId: vaultDelegationGrants.keyId,
          grantedTo: vaultDelegationGrants.grantedTo,
        });
      await eraseInactiveGrantKeyMaterial(revoked, tx);

      // Last, so a failure here rolls the revokes back (see file header).
      const tombstone = await deleteFromVault(field);
      if (!tombstone) {
        // Nothing to tombstone: abort so the revokes above are rolled back too.
        throw new NothingToDeleteError(field);
      }
      return { tombstone, revokedGrantees: revoked.map((grant) => grant.grantedTo) };
    });
  } catch (err) {
    if (err instanceof NothingToDeleteError) return undefined;
    throw err;
  }
}
