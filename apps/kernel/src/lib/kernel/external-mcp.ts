import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, attestations, channelLinks, connectors, identities, registryApps, vaultDelegationGrants, type ConnectorRow } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { isActiveGroupMember } from '@/src/lib/auth/group-membership';
import { APP_AUTHORIZATION_CHANNEL } from '@/src/lib/auth/app-authorization-grant';
import { _applyDelegationGrant, deleteFromVault, revokeStaticSecretGrant, sealAndGrantStaticSecret, vaultService } from '@/src/lib/vault';
import { EXTERNAL_MCP_NAMESPACE, isExternalMcpField } from '@/src/lib/vault/field-grammar';
import { getNodeSigningIdentity, getNodeXPrivateKey, isVaultTier1 } from '@/src/lib/vault/sealing';
import { vaultFieldStatusForGrantee } from '@/src/lib/vault/field-status';
import { connectorRegistryId } from './connector-registry-store';
import { generateId } from './id';
import { connectInput, EXTERNAL_MCP_SCOPE, ExternalMcpError, parseExternalMcpCall, POSTMAN_PROVIDER, type ExternalMcpCall } from './external-mcp-policy';
import { forwardPostmanCall } from './external-mcp-transport';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface ExternalMcpCaller { memberDid: string; appDid?: string; serviceToken?: boolean }
const unavailable = () => new ExternalMcpError(403, 'No active personal external MCP connection or grant');
const live = (row: { status: string; expiresAt: Date | null; revokedAt: Date | null }) =>
  row.status === 'active' && !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > Date.now());

async function lockMember(tx: Transaction, did: string) {
  const lockKey = `external-mcp:${did}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}
async function connection(tx: Pick<Transaction, 'select'>, did: string) {
  const [row] = await tx.select().from(connectors).where(and(
    eq(connectors.ownerDid, did), eq(connectors.provider, POSTMAN_PROVIDER), eq(connectors.slot, 'primary'),
  )).limit(1);
  return row;
}
async function activeIdentity(tx: Pick<Transaction, 'select'>, did: string) {
  const [identity] = await tx.select({ id: identities.id }).from(identities)
    .where(and(eq(identities.id, did), isNull(identities.suspendedAt))).limit(1);
  if (!identity) throw unavailable();
}
async function checkStanding(tx: Pick<Transaction, 'select'>, memberDid: string, orgDid: string | null) {
  await activeIdentity(tx, memberDid);
  if (!orgDid) return;
  await activeIdentity(tx, orgDid);
  if (!await isActiveGroupMember(orgDid, memberDid, tx)) throw unavailable();
}
async function audit(tx: Pick<Transaction, 'insert'>, memberDid: string, orgContextDid: string | null,
  action: 'connected' | 'disconnected' | 'call', extra: Record<string, unknown> = {}) {
  await tx.insert(attestations).values(await prepareMechanicalAttestation({
    subjectDid: memberDid, type: 'connector.external-mcp', contextId: memberDid, contextType: 'external-mcp',
    payload: { provider: POSTMAN_PROVIDER, memberDid, orgContextDid, action, ...extra },
  }));
}
function publicConnection(row: ConnectorRow | undefined) {
  return { provider: 'postman', connected: !!row && live(row), orgContextDid: row?.orgContextDid ?? null };
}
export async function externalMcpStatus(memberDid: string) {
  const row = await connection(db, memberDid);
  const result = publicConnection(row);
  if (result.connected) {
    result.connected = !!row?.sealedKeyField && (await vaultFieldStatusForGrantee(
      row.sealedKeyField, getNodeSigningIdentity().senderDid,
    )) === 'ready';
  }
  return result;
}

/** Immutable fields prevent a failed commit from destroying a prior working seal. */
export function connectExternalMcp(memberDid: string, raw: unknown) {
  const parsed = connectInput.safeParse(raw);
  if (!parsed.success) throw new ExternalMcpError(400, 'Invalid connection input');
  const { secret, orgContextDid } = parsed.data;
  if (orgContextDid?.includes(secret)) throw new ExternalMcpError(400, 'Invalid organization context');
  if (isVaultTier1()) throw new ExternalMcpError(409, 'External MCP requires kernel vault custody');
  return db.transaction(async tx => {
    await lockMember(tx, memberDid);
    await checkStanding(tx, memberDid, orgContextDid ?? null);
    const previous = await connection(tx, memberDid);
    if (previous?.status === 'removed') throw unavailable();
    const node = getNodeSigningIdentity();
    const field = `${EXTERNAL_MCP_NAMESPACE}:${generateId('mcp')}:${memberDid}`;
    const sealed = await sealAndGrantStaticSecret(field, secret, {
      principalDid: memberDid, granteeDid: node.senderDid, purpose: EXTERNAL_MCP_SCOPE, tx,
    });
    if (previous?.sealedKeyField) await revokeStaticSecretGrant(previous.sealedKeyField, node.senderDid, tx);
    await tx.insert(connectors).values({
      id: connectorRegistryId(memberDid, POSTMAN_PROVIDER, 'primary'),
      ownerDid: memberDid, provider: POSTMAN_PROVIDER, slot: 'primary', channel: 'external-mcp',
      connectorDid: node.senderDid, sealedKeyField: field, orgContextDid: orgContextDid ?? null, status: 'active',
    }).onConflictDoUpdate({
      target: [connectors.ownerDid, connectors.provider, connectors.slot],
      set: { sealedKeyField: field, orgContextDid: orgContextDid ?? null,
        status: 'active', revokedAt: null, updatedAt: new Date() },
    });
    await audit(tx, memberDid, orgContextDid ?? null, 'connected');
    await vaultService.set(sealed.entry);
    return { provider: 'postman', connected: true, orgContextDid: orgContextDid ?? null };
  });
}

/** Revoke + signed tombstone, retaining registry, grants and attestation history. */
export function disconnectExternalMcp(memberDid: string) {
  return db.transaction(async tx => {
    await lockMember(tx, memberDid);
    const row = await connection(tx, memberDid);
    if (!row?.sealedKeyField) return { disconnected: true };
    await revokeStaticSecretGrant(row.sealedKeyField, getNodeSigningIdentity().senderDid, tx);
    await tx.update(connectors).set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectors.id, row.id));
    await audit(tx, memberDid, row.orgContextDid, 'disconnected');
    await deleteFromVault(row.sealedKeyField);
    return { disconnected: true };
  });
}

/** Mint-time scope is only a ceiling: registry and member consent are live gates. */
async function authorizeCaller(tx: Transaction, caller: ExternalMcpCaller) {
  if (!caller.appDid) return;
  const [app] = await tx.select().from(registryApps)
    .where(and(eq(registryApps.appDid, caller.appDid), eq(registryApps.status, 'active'))).limit(1);
  if (!app || app.revokedAt) throw unavailable();
  const approved = Array.isArray(app.approvedServiceScopes) ? app.approvedServiceScopes : [];
  if (caller.serviceToken && !approved.includes(EXTERNAL_MCP_SCOPE)) throw unavailable();
  const [grant] = await tx.select({ scopes: channelLinks.scopes }).from(channelLinks).where(and(
    eq(channelLinks.channel, APP_AUTHORIZATION_CHANNEL), eq(channelLinks.did, caller.memberDid),
    eq(channelLinks.appDid, caller.appDid), eq(channelLinks.status, 'active'), isNull(channelLinks.revokedAt),
  )).limit(1);
  if (!Array.isArray(grant?.scopes) || !grant.scopes.includes(EXTERNAL_MCP_SCOPE)) throw unavailable();
}

/** Hold the same member lock through outbound use; disconnect cannot race unseal. */
export function invokeExternalMcp(caller: ExternalMcpCaller, call: ExternalMcpCall) {
  call = parseExternalMcpCall(call);
  return db.transaction(async tx => {
    await lockMember(tx, caller.memberDid);
    await authorizeCaller(tx, caller);
    const row = await connection(tx, caller.memberDid);
    if (!row || !live(row) || !row.sealedKeyField || !isExternalMcpField(row.sealedKeyField)) throw unavailable();
    await checkStanding(tx, caller.memberDid, row.orgContextDid);
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
    // Record the attempt before sending, never arguments, RPC IDs, or provider messages.
    await audit(tx, caller.memberDid, row.orgContextDid, 'call', {
      appDid: caller.appDid ?? null, method: call.method, tool: call.params?.name ?? null,
    });
    // Return an error value so upstream failure doesn't roll back the attempt audit.
    try { return { value: await forwardPostmanCall(call, credential) }; }
    catch { return { error: 'External MCP upstream unavailable' as const }; }
  });
}
