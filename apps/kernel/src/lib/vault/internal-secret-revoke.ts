/**
 * Operator revoke of a self-provisioned internal secret (#2582, split out of #2354).
 *
 * A self-provisioned `internal-secret:<purpose>` has TWO records that must
 * agree: the node's own purpose-tagged self-grant (how `getInternalSecret`
 * reads it) and the `kernel.internal_secret_provisions` claim row (how two
 * boots agree on a single winner). Revoking only the grant — the generic
 * `revokeStaticSecretGrant` — strands the claim row: `getInternalSecret` keeps
 * finding the row, never finds a grant, and (before #2446) every internal
 * request failed until someone deleted the row by hand.
 *
 * `revokeInternalSecret` removes both in ONE database transaction:
 *   1. revoke the node's own self-grant for the field (status + key-material
 *      erase, the same semantics every revoke in the vault applies);
 *   2. delete the provisions row for `(node DID, purpose)`.
 * Either both happen or neither does, so there is never a revoked grant with a
 * live claim, or a cleared claim with a live grant. Nothing is written to the
 * vault file, so there is no non-transactional step to order.
 *
 * ## What the next `getInternalSecret(purpose)` does
 * It RE-PROVISIONS: no active grant and no claim row means it wins a fresh
 * claim, finds nothing readable for the node, and generates a brand-new value
 * (one `vault.secret.generated` attestation) — the same path as first boot.
 * Any external grantee still holding the old wrapped key is left untouched by
 * this function (external revoke is its own operation, unchanged) and is named
 * in an ERROR by that re-provision so an operator re-grants it. On Tier 1 the
 * node cannot self-grant, so a re-provision could not succeed; revoke is
 * refused up front, before anything is written, rather than failing closed on
 * the next read.
 *
 * Only THIS process's cached value is dropped (after commit). Other running
 * processes keep serving the value they already hold until they restart or
 * observe a rotation — a revoke withdraws the grant, it does not reach into
 * memory it cannot see.
 */
import { createLogger } from '@imajin/logger';
import { and, eq } from 'drizzle-orm';
import { db, internalSecretProvisions } from '@/src/db';
import { getNodeSigningIdentity, isVaultTier1 } from './sealing';
import { listActiveGrantsForField, revokeStaticSecretGrant } from './index';
import { internalSecretField, invalidateInternalSecret } from './internal-secret';

const log = createLogger('kernel');

/** What a revoke actually changed — both false means there was nothing to revoke. */
export interface RevokeInternalSecretResult {
  /** The node's own active self-grant was revoked. */
  selfGrantRevoked: boolean;
  /** The `internal_secret_provisions` row was deleted. */
  provisionCleared: boolean;
}

/**
 * Revoke the self-grant of the self-provisioned internal secret for `purpose`
 * and clear its provisions row, atomically. Idempotent: with nothing to
 * revoke it changes nothing and reports `false`/`false`. No plaintext is
 * logged at any point.
 */
export async function revokeInternalSecret(purpose: string): Promise<RevokeInternalSecretResult> {
  const field = internalSecretField(purpose);
  if (isVaultTier1()) {
    throw new Error(
      `vault revoke: '${field}' is a self-provisioned internal secret — Tier 1 vault custody is not supported ` +
        'for internal secrets yet, so the node could not re-provision it after a revoke; nothing was changed',
    );
  }

  const ownerDid = getNodeSigningIdentity().senderDid;

  const outcome = await db.transaction(async (tx) => {
    const selfGrantRevoked = await revokeStaticSecretGrant(field, ownerDid, tx);
    const cleared = await tx
      .delete(internalSecretProvisions)
      .where(and(eq(internalSecretProvisions.ownerDid, ownerDid), eq(internalSecretProvisions.purpose, purpose)))
      .returning({ id: internalSecretProvisions.id });
    const externalGrantees = (await listActiveGrantsForField(field, tx))
      .map((grant) => grant.grantedTo)
      .filter((did) => did !== ownerDid);
    return { selfGrantRevoked, provisionCleared: cleared.length > 0, externalGrantees };
  });

  invalidateInternalSecret(purpose);

  const { externalGrantees, ...result } = outcome;
  log.info(
    { field, purpose, ...result, externalGranteesUntouched: externalGrantees },
    'Vault: revoked an internal secret — self-grant and provisions row removed together; the next getInternalSecret re-provisions it',
  );
  return result;
}
