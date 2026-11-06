import { and, eq, inArray } from 'drizzle-orm';
import { db, vaultDelegationGrants } from '@/src/db';
import { getNodeSigningIdentity } from './sealing';

type CustodyTransaction = Pick<Parameters<Parameters<typeof db.transaction>[0]>[0], 'select'>;

/**
 * Find this node's active custody for an already-authorized, exact field.
 * sealAndStoreV2 writes subject = grantedTo = node.senderDid (#1603):
 * https://github.com/ima-jin/imajin-ai/issues/1603.
 * Transitional owner-subject grants are also accepted, but the field, node
 * recipient and active status are mandatory for BOTH shapes. Callers retain
 * field/owner authorization, expiry, revocation, oneTime and crypto checks.
 * Pass the caller's transaction and lock when custody must remain stable.
 */
export async function findNodeCustodyGrant({
  field, ownerDid, tx, lock = false,
}: { field: string; ownerDid: string; tx: CustodyTransaction; lock?: boolean }) {
  const nodeDid = getNodeSigningIdentity().senderDid;
  const query = tx.select().from(vaultDelegationGrants).where(and(
    eq(vaultDelegationGrants.field, field),
    inArray(vaultDelegationGrants.subject, [nodeDid, ownerDid]),
    eq(vaultDelegationGrants.grantedTo, nodeDid),
    eq(vaultDelegationGrants.status, 'active'),
  )).limit(1);
  const [grant] = await (lock ? query.for('update') : query);
  return grant;
}
