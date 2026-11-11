import { and, eq, isNull, isNotNull, or } from 'drizzle-orm';
import { db, channelLinks, connectors, identities, registryApps, orgConnectionSuspensions, type ConnectorRow } from '@/src/db';
import { isActiveGroupMember } from '@/src/lib/auth/group-membership';
import { APP_AUTHORIZATION_CHANNEL } from '@/src/lib/auth/app-authorization-grant';
import { ExternalMcpError, EXTERNAL_MCP_SCOPE, POSTMAN_PROVIDER, type ConnectionErrorCode } from './external-mcp-policy';
import { missingConnection, resolveConnectionPrincipal, type ConnectionCaller } from './connection-principal';
import { isHeldBy } from './connection-holding';
import { orgConnectionRequiresReseal } from './connection-principal-policy';

export type ConnectionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface ExternalMcpCaller { memberDid: string; appDid?: string; serviceToken?: boolean; caller?: ConnectionCaller }
export interface MemberConnectionTarget {
  provider: string; scope: string; binding?: string; service?: string; upstreamId?: string; connectionId?: string;
}
export const POSTMAN_CONNECTION = { provider: POSTMAN_PROVIDER, scope: EXTERNAL_MCP_SCOPE };
export const connectionUnavailable = (code: ConnectionErrorCode = 'connection_not_loaded', fixActingDid?: string) =>
  new ExternalMcpError(403, 'No active personal external MCP connection or grant', code, fixActingDid);
export const isLiveConnection = (row: { status: string; expiresAt: Date | null; revokedAt: Date | null }) =>
  row.status === 'active' && !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > Date.now());
export const hasOrgConnectionProvenance = (row: ConnectorRow) =>
  !!(row.loadedByDid && row.loadedAt);

export async function findMemberConnection(
  tx: Pick<ConnectionTransaction, 'select'>, memberDid: string, provider: string, binding?: string,
) {
  const rows = await tx.select().from(connectors).where(and(
    eq(connectors.ownerDid, memberDid),
    eq(connectors.purpose, 'inference'),
    ...(binding === undefined
      ? [eq(connectors.provider, provider), eq(connectors.slot, 'primary')]
      : [eq(connectors.upstreamBinding, binding), eq(connectors.slot, binding)]),
  ));
  if (rows.length !== 1) return undefined;
  return isHeldBy(rows[0], memberDid) ? rows[0] : undefined;
}
async function activeIdentity(tx: Pick<ConnectionTransaction, 'select'>, did: string) {
  const [identity] = await tx.select({ id: identities.id }).from(identities)
    .where(and(eq(identities.id, did), isNull(identities.suspendedAt))).limit(1);
  if (!identity) throw connectionUnavailable('identity_inactive');
}
export async function checkMemberStanding(tx: Pick<ConnectionTransaction, 'select'>, memberDid: string, orgDid: string | null) {
  await activeIdentity(tx, memberDid);
  if (!orgDid || orgDid === memberDid) return;
  await activeIdentity(tx, orgDid);
  if (!await isActiveGroupMember(orgDid, memberDid, tx)) throw connectionUnavailable('org_membership_required', orgDid);
}
export async function requireConnectionApp(tx: Pick<ConnectionTransaction, 'select'>, appDid: string, scope: string, serviceToken: boolean) {
  const [app] = await tx.select().from(registryApps)
    .where(and(eq(registryApps.appDid, appDid), eq(registryApps.status, 'active'))).limit(1);
  if (!app || app.revokedAt) throw connectionUnavailable();
  if (serviceToken && !app.approvedServiceScopes.includes(scope)) throw connectionUnavailable();
  return app;
}
async function authorizeCaller(tx: Pick<ConnectionTransaction, 'select'>, caller: ExternalMcpCaller, scope: string) {
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
 * Org-admin suspension is enforced HERE only, before either caller accesses custody.
 * A token, org membership, or a selected member DID alone is never authority.
 * Call under the member custody snapshot lock, before any credential unseal.
 */
export async function authorizeMemberConnection(
  tx: Pick<ConnectionTransaction, 'select'>, caller: ExternalMcpCaller, target: MemberConnectionTarget = POSTMAN_CONNECTION,
): Promise<ConnectorRow> {
  await authorizeCaller(tx, caller, target.scope);
  const principal = caller.caller
    ? await resolveConnectionPrincipal(caller.caller, target.service ?? 'connections', tx) : { ownerDid: caller.memberDid };
  const orgContext = 'orgContext' in principal ? principal.orgContext : undefined;
  if (orgContext && !orgContext.assignedAgentDid) {
    const { requireOrgConnectionMemberGrant } = await import('./org-connection-member-grants');
    await requireOrgConnectionMemberGrant({
      memberDid: orgContext.memberDid, orgDid: orgContext.orgDid, actingDid: orgContext.orgDid, provider: target.provider,
    }, tx);
  }
  const row = await findMemberConnection(tx, principal.ownerDid, target.provider, target.binding);
  if (caller.caller && (!row || !isLiveConnection(row) || !row.sealedKeyField)) throw missingConnection(principal.ownerDid);
  if (!row || !isLiveConnection(row) || !row.sealedKeyField) throw connectionUnavailable();
  if (orgContext && !hasOrgConnectionProvenance(row)) throw orgConnectionRequiresReseal(principal.ownerDid);
  if (target.binding !== undefined && row.upstreamBinding !== target.binding) throw connectionUnavailable();
  await checkMemberStanding(tx, principal.ownerDid, row.orgContextDid);
  const orgDid = orgContext?.orgDid ?? row.orgContextDid;
  if (orgDid) {
    const [suspension] = await tx.select({ provider: orgConnectionSuspensions.provider })
      .from(orgConnectionSuspensions).where(and(
        eq(orgConnectionSuspensions.orgDid, orgDid),
        eq(orgConnectionSuspensions.provider, row.provider),
        isNotNull(orgConnectionSuspensions.suspendedAt),
        or(
          eq(orgConnectionSuspensions.memberDid, ''),
          and(eq(orgConnectionSuspensions.memberDid, caller.caller?.actorDid ?? caller.memberDid),
            or(eq(orgConnectionSuspensions.slot, ''), eq(orgConnectionSuspensions.slot, row.slot))),
        ),
      )).limit(1);
    if (suspension) throw connectionUnavailable('connection_suspended', orgDid);
  }
  return row;
}
