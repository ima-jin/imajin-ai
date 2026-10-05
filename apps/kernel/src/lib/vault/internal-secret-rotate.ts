/**
 * Operator rotation of a self-provisioned internal secret (#2446).
 *
 * An `internal-secret:<purpose>` field is found by PURPOSE
 * (`getInternalSecret` → `findActiveGrant`) and tracked by its
 * `kernel.internal_secret_provisions` row. The generic v2 re-seal
 * (`sealAndStoreV2`) knows neither: before this module, rotating such a field
 * from /admin/vault minted the replacement grant with `purpose = NULL`, left
 * the provisions row pointing at the superseded grant, and left every
 * external consumer's grant carrying the OLD wrapped key. The kernel kept
 * working only until its next restart.
 *
 * Rotation here is the same custody path that provisioned the field:
 *   1. re-seal + self-grant with the purpose, and repoint the provisions row
 *      (`sealAndRecordInternalSecret` — shared with first-boot generation of a
 *      fresh secret, so the two can never drift apart);
 *   2. re-issue each prior external grantee on the new key with its own
 *      purpose/expiry/one-time carried forward (expired or consumed grants
 *      are dropped, never renewed);
 *   3. drop this process's cached value so the next read resolves the new
 *      grant without a restart.
 *
 * ## All or nothing (#2451)
 * Steps 1 and 2 used to be separate writes, so a failure between them (or
 * between a grantee's supersede and its re-issue) left the field half-rotated:
 * grantees stale or grant-less until someone re-ran it. They now run in ONE
 * database transaction. The vault entry is a file write no rollback can undo,
 * so it is persisted LAST inside that transaction: any failure before it
 * rolls the database back and leaves the old entry, every grant and the
 * provisions row exactly as they were (re-running is then a clean retry), and
 * the cache, bus events and log line only fire after commit. The one residual
 * window — the commit itself failing right after the entry was saved — is
 * logged loudly with the field name so the operator re-runs the rotate.
 *
 * Tier 1 (external owner agent) is refused BEFORE anything is written: the
 * node cannot self-grant there, and a half-applied rotation would strand the
 * field exactly the way this module exists to prevent.
 */
import type { VaultEntry } from '@imajin/vault-core';
import { createLogger } from '@imajin/logger';
import { db } from '@/src/db';
import { getNodeSigningIdentity, isVaultTier1 } from './sealing';
import { listActiveGrantsForField, vaultService } from './index';
import {
  invalidateInternalSecret,
  purposeFromInternalSecretField,
  sealAndRecordInternalSecret,
} from './internal-secret';
import { reissueInternalSecretGrants } from './shared-internal-secret';

const log = createLogger('kernel');

/** Attribution for grants re-issued by a rotation (the operator is on the rotate event itself). */
const ROTATION_GRANTED_BY = 'vault.rotate';

/**
 * Rotate `field` (an `internal-secret:*` field) to `plaintext`. Returns the
 * new vault entry, exactly like `rotateAndStore` does for any other field.
 * No plaintext is logged at any point.
 */
export async function rotateInternalSecret(field: string, plaintext: string): Promise<VaultEntry> {
  const purpose = purposeFromInternalSecretField(field);
  if (isVaultTier1()) {
    throw new Error(
      `vault rotate: '${field}' is a self-provisioned internal secret — Tier 1 vault custody is not supported ` +
        'for internal secrets yet, so the node cannot re-grant it to itself; nothing was changed',
    );
  }

  const ownerDid = getNodeSigningIdentity().senderDid;

  const { entry, grantId, reissued, dropped, announce } = await db
    .transaction(async (tx) => {
      // Read BEFORE the re-seal: listActiveGrantsForField is newest-first, which
      // is the grant whose terms a re-issue carries forward.
      const previousGrants = await listActiveGrantsForField(field, tx);
      const sealed = await sealAndRecordInternalSecret(ownerDid, purpose, plaintext, tx);
      const reissue = await reissueInternalSecretGrants({
        purpose,
        sourceGrantId: sealed.grantId,
        previousGrants,
        grantedBy: ROTATION_GRANTED_BY,
        executor: tx,
      });
      // LAST: the one write a rollback cannot undo (see the module docblock).
      await vaultService.set(sealed.entry);
      return { ...sealed, ...reissue };
    })
    .catch((err: unknown) => {
      log.error(
        { err: String(err), field, purpose },
        'Vault: internal-secret rotate failed — grants and the provisions row were rolled back together; re-run the rotate (if the failure was the final commit, the entry may already hold the new value and the re-run repairs the grants)',
      );
      throw err;
    });

  invalidateInternalSecret(purpose);
  announce();

  log.info(
    { field, purpose, grantId, reissuedGrantIds: reissued, droppedExpiredGrantees: dropped },
    'Vault: rotated an internal secret — purpose kept, provisions row and external grantees moved to the new key',
  );
  return entry;
}
