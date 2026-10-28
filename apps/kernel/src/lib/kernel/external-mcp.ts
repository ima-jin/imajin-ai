import { and, eq, sql } from 'drizzle-orm';
import { db, attestations, connectors, vaultDelegationGrants, type ConnectorRow } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { _applyDelegationGrant, deleteFromVault, revokeStaticSecretGrant, sealAndGrantStaticSecret, vaultService } from '@/src/lib/vault';
import { EXTERNAL_MCP_NAMESPACE, isExternalMcpField } from '@/src/lib/vault/field-grammar';
import { getNodeSigningIdentity, getNodeXPrivateKey, isVaultTier1 } from '@/src/lib/vault/sealing';
import { vaultFieldStatusForGrantee } from '@/src/lib/vault/field-status';
import { connectorRegistryId } from './connector-registry-store';
import { generateId } from './id';
import { connectInput, ExternalMcpError, parseExternalMcpCall, POSTMAN_PROVIDER, type ExternalMcpCall } from './external-mcp-policy';
import { forwardPostmanCall } from './external-mcp-transport';
import { reserveExternalMcpCall } from './external-mcp-limits';
import {
  authorizeMemberConnection, checkMemberStanding as checkStanding, findMemberConnection,
  connectionUnavailable as unavailable, isLiveConnection as live, POSTMAN_CONNECTION,
  type ExternalMcpCaller, type MemberConnectionTarget,
} from './member-connection-gate';
export type { ExternalMcpCaller } from './member-connection-gate';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockMember(tx: Transaction, did: string) {
  const lockKey = `external-mcp:${did}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}
const connection = (tx: Pick<Transaction, 'select'>, did: string, provider = POSTMAN_PROVIDER) =>
  findMemberConnection(tx, did, provider);
export async function auditMemberConnection(tx: Pick<Transaction, 'insert'>, memberDid: string, orgContextDid: string | null,
  action: 'connected' | 'disconnected' | 'call', extra: Record<string, unknown> = {}, provider = POSTMAN_PROVIDER) {
  await tx.insert(attestations).values(await prepareMechanicalAttestation({
    subjectDid: memberDid, type: 'connector.external-mcp', contextId: memberDid, contextType: 'external-mcp',
    payload: { provider, memberDid, orgContextDid, action, ...extra },
  }));
}
function publicConnection(row: ConnectorRow | undefined, target: MemberConnectionTarget = POSTMAN_CONNECTION) {
  return { provider: target.provider === POSTMAN_PROVIDER ? 'postman' : target.provider,
    connected: !!row && live(row) && (target.binding === undefined || row.upstreamBinding === target.binding),
    orgContextDid: row?.orgContextDid ?? null };
}
export async function externalMcpStatus(memberDid: string, target: MemberConnectionTarget = POSTMAN_CONNECTION) {
  const row = await connection(db, memberDid, target.provider);
  const result = publicConnection(row, target);
  if (result.connected) {
    result.connected = !!row?.sealedKeyField && (await vaultFieldStatusForGrantee(
      row.sealedKeyField, getNodeSigningIdentity().senderDid,
    )) === 'ready';
  }
  return result;
}

/** Immutable fields prevent a failed commit from destroying a prior working seal. */
export function connectExternalMcp(memberDid: string, raw: unknown, target: MemberConnectionTarget = POSTMAN_CONNECTION, appDid?: string) {
  const parsed = connectInput.safeParse(raw);
  if (!parsed.success) throw new ExternalMcpError(400, 'Invalid connection input');
  const { secret, orgContextDid } = parsed.data;
  if (orgContextDid?.includes(secret)) throw new ExternalMcpError(400, 'Invalid organization context');
  if (JSON.stringify([memberDid, appDid, target]).includes(secret)) throw new ExternalMcpError(400, 'Invalid connection metadata');
  if (isVaultTier1()) throw new ExternalMcpError(409, 'External MCP requires kernel vault custody');
  return db.transaction(async tx => {
    await lockMember(tx, memberDid);
    await checkStanding(tx, memberDid, orgContextDid ?? null);
    const previous = await connection(tx, memberDid, target.provider);
    if (previous?.status === 'removed') throw unavailable();
    const node = getNodeSigningIdentity();
    const field = `${EXTERNAL_MCP_NAMESPACE}:${generateId('mcp')}:${memberDid}`;
    const sealed = await sealAndGrantStaticSecret(field, secret, {
      principalDid: memberDid, granteeDid: node.senderDid, purpose: target.scope, tx,
    });
    if (previous?.sealedKeyField) await revokeStaticSecretGrant(previous.sealedKeyField, node.senderDid, tx);
    await tx.insert(connectors).values({
      id: connectorRegistryId(memberDid, target.provider, 'primary'),
      ownerDid: memberDid, provider: target.provider, slot: 'primary', channel: 'external-mcp',
      connectorDid: node.senderDid, sealedKeyField: field, orgContextDid: orgContextDid ?? null,
      upstreamBinding: target.binding ?? null, status: 'active',
    }).onConflictDoUpdate({
      target: [connectors.ownerDid, connectors.provider, connectors.slot],
      set: { sealedKeyField: field, orgContextDid: orgContextDid ?? null, upstreamBinding: target.binding ?? null,
        status: 'active', revokedAt: null, updatedAt: new Date() },
    });
    await auditMemberConnection(tx, memberDid, orgContextDid ?? null, 'connected', { appDid: appDid ?? null }, target.provider);
    await vaultService.set(sealed.entry);
    if (previous?.sealedKeyField) await deleteFromVault(previous.sealedKeyField);
    return { provider: target.provider === POSTMAN_PROVIDER ? 'postman' : target.provider, connected: true, orgContextDid: orgContextDid ?? null };
  });
}
/** Revoke + signed tombstone, retaining registry, grants and attestation history. */
export function disconnectExternalMcp(memberDid: string, target: MemberConnectionTarget = POSTMAN_CONNECTION, appDid?: string) {
  return db.transaction(async tx => {
    await lockMember(tx, memberDid);
    const row = await connection(tx, memberDid, target.provider);
    if (!row?.sealedKeyField) return { disconnected: true };
    await revokeStaticSecretGrant(row.sealedKeyField, getNodeSigningIdentity().senderDid, tx);
    await tx.update(connectors).set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectors.id, row.id));
    await auditMemberConnection(tx, memberDid, row.orgContextDid, 'disconnected', { appDid: appDid ?? null }, target.provider);
    await deleteFromVault(row.sealedKeyField);
    return { disconnected: true };
  });
}


/** Short custody snapshot, serialized with connect/disconnect only until unseal. */
export function authorizeExternalMcp(caller: ExternalMcpCaller, target: MemberConnectionTarget = POSTMAN_CONNECTION) {
  return db.transaction(async tx => {
    await lockMember(tx, caller.memberDid);
    const row = await authorizeMemberConnection(tx, caller, target);
    if (!row.sealedKeyField || !isExternalMcpField(row.sealedKeyField)) throw unavailable();
    const node = getNodeSigningIdentity();
    const [custody] = await tx.select().from(vaultDelegationGrants).where(and(
      eq(vaultDelegationGrants.field, row.sealedKeyField), eq(vaultDelegationGrants.subject, caller.memberDid),
      eq(vaultDelegationGrants.grantedTo, node.senderDid), eq(vaultDelegationGrants.status, 'active'),
    )).limit(1).for('update');
    if (!custody || !live(custody) || custody.oneTime) throw unavailable();
    const entry = await vaultService.get(row.sealedKeyField);
    if (!entry || entry.deleted || entry.senderPubkey !== node.senderPubkey || entry.custodyScheme !== 'delegation-grant') {
      throw unavailable();
    }
    const credential = await _applyDelegationGrant(entry, custody, getNodeXPrivateKey(), node.senderPubkey);
    if (!live(custody)) throw unavailable();
    return { credential, orgContextDid: row.orgContextDid };
  });
}

/** No DB transaction or lock spans network I/O. Already-admitted calls may finish after disconnect. */
export async function invokeExternalMcp(caller: ExternalMcpCaller, call: ExternalMcpCall) {
  call = parseExternalMcpCall(call);
  const release = reserveExternalMcpCall(caller.memberDid, caller.appDid);
  try {
    const context = await authorizeExternalMcp(caller);
    let result;
    try { result = { value: await forwardPostmanCall(call, context.credential) }; }
    catch { result = { error: 'External MCP upstream unavailable' as const }; }
    finally { context.credential = ''; }
    // A second short transaction records the admitted attempt, never provider bytes or arguments.
    await db.transaction(tx => auditMemberConnection(tx, caller.memberDid, context.orgContextDid, 'call', {
      appDid: caller.appDid ?? null, method: call.method, tool: call.params?.name ?? null,
    }));
    return result;
  } finally {
    release();
  }
}
