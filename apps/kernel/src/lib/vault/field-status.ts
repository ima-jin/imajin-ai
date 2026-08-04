/**
 * Vault field status (#1521).
 *
 * `vaultFieldExists` answers a binary question — "is there a usable, verified
 * secret here?" — and that binary was fine while every writer was v1 or Tier 0
 * v2, where a delegation grant always exists the instant the entry does (the
 * self-grant is written in the same call as the seal). It stops being fine the
 * moment a Tier 1 writer seals a field and the owner agent hasn't answered yet:
 * the entry exists and verifies, but `loadAndUnseal` throws `VaultDelegationError`
 * because no grant covers it. That state had no name, so callers reported it as
 * either "sealed" (vaultFieldExists — wrong, it can't be read) or let the
 * exception surface as an opaque failure.
 *
 * `vaultFieldStatus` names it. `pending-grant` is structurally impossible in
 * Tier 0 for exactly the reason above; it only exists to describe the gap that
 * opens up between "the node sealed a v2 entry" and "the owner agent granted
 * access to it".
 *
 * `vaultFieldExists` is left untouched (see ./index.ts) — its contract is now
 * simply `status === 'ready'`, and it stays that way so existing callers do not
 * silently shift meaning.
 */
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { verifyEntryIntegrity } from '@imajin/vault-core';
import { db, vaultDelegationGrants } from '@/src/db';
import { vaultAdapters, vaultService } from './index';
import { getNodeSigningIdentity } from './sealing';

export type VaultFieldStatus = 'absent' | 'ready' | 'pending-grant' | 'unverifiable';

/**
 * Resolve the current status of a vault field without unsealing it.
 *
 *   'absent'         — no entry, or the latest entry is a tombstone.
 *   'unverifiable'   — an entry exists but fails integrity verification
 *                       (tamper, wrong signer, corrupt chain).
 *   'ready'          — a v1 node-sealed entry (always readable by this node
 *                       once verified), OR a v2 delegation-grant entry with an
 *                       active, non-expired grant naming this node.
 *   'pending-grant'  — a v2 delegation-grant entry that verifies, but no active
 *                       grant covers it yet. This is what a fresh Tier 1 seal
 *                       looks like before the owner agent responds, and what a
 *                       lapsed grant looks like before it is renewed (#1535).
 *
 * Only answers for fields granted to THIS NODE. A static-secret field (#1439) is
 * granted to a connector app DID, so asking this function about one always yields
 * `pending-grant` even when it is perfectly readable — use
 * {@link vaultFieldStatusForGrantee} for those.
 *
 * Never unseals — safe for status checks where the plaintext is not needed.
 */
export async function vaultFieldStatus(field: string): Promise<VaultFieldStatus> {
  return vaultFieldStatusForGrantee(field, getNodeSigningIdentity().senderDid);
}

/**
 * As {@link vaultFieldStatus}, but for a field whose grant names `granteeDid`
 * rather than the node (#1603).
 *
 * This exists because the grant lookup is the only part of the status that varies
 * by grantee, and getting it wrong is invisible: a static-secret field checked
 * against the node's DID finds no grant and reports `pending-grant`, which a
 * connector surface renders as "waiting for owner approval" for a credential that
 * actually works.
 *
 * The distinction is authorization-only. Whoever `granteeDid` is, the node still
 * holds the wrapped key and does the decrypting (see `loadAndUnsealByGrantee`).
 */
export async function vaultFieldStatusForGrantee(
  field: string,
  granteeDid: string,
): Promise<VaultFieldStatus> {
  const entry = await vaultService.peek(field);
  if (!entry || entry.deleted === true) {
    return 'absent';
  }

  const verified = await verifyEntryIntegrity(entry, vaultAdapters);
  if (!verified.ok) {
    return 'unverifiable';
  }

  if (entry.custodyScheme !== 'delegation-grant') {
    // v1 node-sealed: readable directly with the node's derived seal key,
    // no grant involved.
    return 'ready';
  }

  const rows = await db
    .select({ id: vaultDelegationGrants.id })
    .from(vaultDelegationGrants)
    .where(
      and(
        eq(vaultDelegationGrants.grantedTo, granteeDid),
        eq(vaultDelegationGrants.field, field),
        eq(vaultDelegationGrants.status, 'active'),
        or(
          isNull(vaultDelegationGrants.expiresAt),
          gt(vaultDelegationGrants.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);

  return rows.length > 0 ? 'ready' : 'pending-grant';
}
