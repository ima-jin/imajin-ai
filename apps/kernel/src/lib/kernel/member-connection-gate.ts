import { and, eq, isNull } from 'drizzle-orm';
import { db, channelLinks, connectors, identities, registryApps, type ConnectorRow } from '@/src/db';
import { isActiveGroupMember } from '@/src/lib/auth/group-membership';
import { APP_AUTHORIZATION_CHANNEL } from '@/src/lib/auth/app-authorization-grant';
import { ExternalMcpError, EXTERNAL_MCP_SCOPE, POSTMAN_PROVIDER } from './external-mcp-policy';

export type ConnectionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface ExternalMcpCaller { memberDid: string; appDid?: string; serviceToken?: boolean }
export interface MemberConnectionTarget { provider: string; scope: string; binding?: string }
export const POSTMAN_CONNECTION = { provider: POSTMAN_PROVIDER, scope: EXTERNAL_MCP_SCOPE };
export const connectionUnavailable = () => new ExternalMcpError(403, 'No active personal external MCP connection or grant');
export const isLiveConnection = (row: { status: string; expiresAt: Date | null; revokedAt: Date | null }) =>
  row.status === 'active' && !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > Date.now());

export async function findMemberConnection(tx: Pick<ConnectionTransaction, 'select'>, memberDid: string, provider: string) {
  const [row] = await tx.select().from(connectors).where(and(
    eq(connectors.ownerDid, memberDid), eq(connectors.provider, provider), eq(connectors.slot, 'primary'),
  )).limit(1);
  return row;
}
async function activeIdentity(tx: Pick<ConnectionTransaction, 'select'>, did: string) {
  const [identity] = await tx.select({ id: identities.id }).from(identities)
    .where(and(eq(identities.id, did), isNull(identities.suspendedAt))).limit(1);
  if (!identity) throw connectionUnavailable();
}
export async function checkMemberStanding(tx: Pick<ConnectionTransaction, 'select'>, memberDid: string, orgDid: string | null) {
  await activeIdentity(tx, memberDid);
  if (!orgDid) return;
  await activeIdentity(tx, orgDid);
  if (!await isActiveGroupMember(orgDid, memberDid, tx)) throw connectionUnavailable();
}
export async function requireConnectionApp(tx: Pick<ConnectionTransaction, 'select'>, appDid: string, scope: string, serviceToken: boolean) {
  const [app] = await tx.select().from(registryApps)
    .where(and(eq(registryApps.appDid, appDid), eq(registryApps.status, 'active'))).limit(1);
  if (!app || app.revokedAt) throw connectionUnavailable();
  if (serviceToken && !app.approvedServiceScopes.includes(scope)) throw connectionUnavailable();
  return app;
}
async function authorizeCaller(tx: ConnectionTransaction, caller: ExternalMcpCaller, scope: string) {
  if (!caller.appDid) return;
  await requireConnectionApp(tx, caller.appDid, scope, caller.serviceToken === true);
  const [grant] = await tx.select({ scopes: channelLinks.scopes }).from(channelLinks).where(and(
    eq(channelLinks.channel, APP_AUTHORIZATION_CHANNEL), eq(channelLinks.did, caller.memberDid),
    eq(channelLinks.appDid, caller.appDid), eq(channelLinks.status, 'active'), isNull(channelLinks.revokedAt),
  )).limit(1);
  if (!Array.isArray(grant?.scopes) || !grant.scopes.includes(scope)) throw connectionUnavailable();
}
/**
 * One per-call gate for BOTH member MCP and app upstream paths.
 * #3167: extend HERE with org-admin connection/service suspension checks.
 * A token, org membership, or a selected member DID alone is never authority.
 * Call under the member custody snapshot lock, before any credential unseal.
 */
export async function authorizeMemberConnection(
  tx: ConnectionTransaction, caller: ExternalMcpCaller, target: MemberConnectionTarget = POSTMAN_CONNECTION,
): Promise<ConnectorRow> {
  await authorizeCaller(tx, caller, target.scope);
  const row = await findMemberConnection(tx, caller.memberDid, target.provider);
  if (!row || !isLiveConnection(row) || !row.sealedKeyField) throw connectionUnavailable();
  if (target.binding !== undefined && row.upstreamBinding !== target.binding) throw connectionUnavailable();
  await checkMemberStanding(tx, caller.memberDid, row.orgContextDid);
  return row;
}
