import { and, eq, inArray } from 'drizzle-orm';
import { vaultDelegationGrants } from '@/src/db';
import { isExternalMcpField } from '@/src/lib/vault/field-grammar';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import {
  authorizeMemberConnection, connectionUnavailable, isLiveConnection, POSTMAN_CONNECTION,
  type ConnectionTransaction, type ExternalMcpCaller, type MemberConnectionTarget,
} from './member-connection-gate';

/** Shared call/discovery decision. Reads authorization metadata, never credential bytes. */
export async function authorizeExternalMcpAccess(
  tx: Pick<ConnectionTransaction, 'select'>, caller: ExternalMcpCaller, target: MemberConnectionTarget = POSTMAN_CONNECTION,
) {
  const row = await authorizeMemberConnection(tx, caller, target);
  if (!row.sealedKeyField || !isExternalMcpField(row.sealedKeyField)) throw connectionUnavailable();
  const [custody] = await tx.select({
    id: vaultDelegationGrants.id, status: vaultDelegationGrants.status,
    expiresAt: vaultDelegationGrants.expiresAt, revokedAt: vaultDelegationGrants.revokedAt,
    oneTime: vaultDelegationGrants.oneTime,
  }).from(vaultDelegationGrants).where(and(
    eq(vaultDelegationGrants.field, row.sealedKeyField), inArray(vaultDelegationGrants.subject, [row.ownerDid, getNodeSigningIdentity().senderDid]),
    eq(vaultDelegationGrants.grantedTo, getNodeSigningIdentity().senderDid),
    eq(vaultDelegationGrants.status, 'active'),
  )).limit(1);
  const custodyId = custody && isLiveConnection(custody) && !custody.oneTime ? custody.id : null;
  return { row, custodyId };
}
