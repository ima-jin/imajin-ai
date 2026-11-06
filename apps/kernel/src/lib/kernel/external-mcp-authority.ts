import { isExternalMcpField } from '@/src/lib/vault/field-grammar';
import { findNodeCustodyGrant } from '@/src/lib/vault/node-custody-grant';
import {
  authorizeMemberConnection, connectionUnavailable, isLiveConnection, POSTMAN_CONNECTION,
  type ConnectionTransaction, type ExternalMcpCaller, type MemberConnectionTarget,
} from './member-connection-gate';

/** Shared call/discovery decision. Checks custody without unsealing credential bytes. */
export async function authorizeExternalMcpAccess(
  tx: Pick<ConnectionTransaction, 'select'>, caller: ExternalMcpCaller, target: MemberConnectionTarget = POSTMAN_CONNECTION,
) {
  const row = await authorizeMemberConnection(tx, caller, target);
  if (!row.sealedKeyField || !isExternalMcpField(row.sealedKeyField)) throw connectionUnavailable();
  const custody = await findNodeCustodyGrant({ field: row.sealedKeyField, ownerDid: row.ownerDid, tx });
  const custodyId = custody && isLiveConnection(custody) && !custody.oneTime ? custody.id : null;
  return { row, custodyId };
}
