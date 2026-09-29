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
 *      (`sealAndRecordInternalSecret` — shared with first-boot generation and
 *      bootstrap re-provisioning, so the three can never drift apart);
 *   2. re-issue each prior external grantee on the new key with its own
 *      purpose/expiry/one-time carried forward (expired or consumed grants
 *      are dropped, never renewed);
 *   3. drop this process's cached value so the next read resolves the new
 *      grant without a restart.
 *
 * Tier 1 (external owner agent) is refused BEFORE anything is written: the
 * node cannot self-grant there, and a half-applied rotation would strand the
 * field exactly the way this module exists to prevent.
 */
import type { VaultEntry } from '@imajin/vault-core';
import { createLogger } from '@imajin/logger';
import { getNodeSigningIdentity, isVaultTier1 } from './sealing';
import { listActiveGrantsForField } from './index';
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
  // Read BEFORE the re-seal: listActiveGrantsForField is newest-first, which
  // is the grant whose terms a re-issue carries forward.
  const previousGrants = await listActiveGrantsForField(field);

  const { entry, grantId } = await sealAndRecordInternalSecret(ownerDid, purpose, plaintext);
  invalidateInternalSecret(purpose);

  const { reissued, dropped } = await reissueInternalSecretGrants({
    purpose,
    sourceGrantId: grantId,
    previousGrants,
    grantedBy: ROTATION_GRANTED_BY,
  });

  log.info(
    { field, purpose, grantId, reissuedGrantIds: reissued, droppedExpiredGrantees: dropped },
    'Vault: rotated an internal secret — purpose kept, provisions row and external grantees moved to the new key',
  );
  return entry;
}
