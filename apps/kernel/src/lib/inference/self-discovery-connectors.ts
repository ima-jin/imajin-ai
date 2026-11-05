import { db } from '@/src/db';
import { forEachSequential } from '@/src/lib/async/sequential';
import { CONNECTOR_REGISTRY, type ConnectorEntry } from '@/src/lib/kernel/connector-registry';
import { listConnectorRegistrations } from '@/src/lib/kernel/connector-registry-store';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
import { authorizeExternalMcpAccess } from '@/src/lib/kernel/external-mcp-authority';
import { resolveConnectionPrincipal } from '@/src/lib/kernel/connection-principal';
import { isOrgScope } from '@/src/lib/kernel/connection-principal-policy';
import {
  POSTMAN_CONNECTION, requireConnectionApp, type MemberConnectionTarget,
  type ExternalMcpCaller,
} from '@/src/lib/kernel/member-connection-gate';
import {
  parseUpstream, upstreamDeclarations, upstreamBinding, upstreamProvider, UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE,
  type AppUpstream,
} from '@/src/lib/kernel/app-upstream-policy';
import { resolveActiveMcpGrant } from '@/src/lib/mcp/mcp-grant';
import { listBrainConnectors } from './brain';
import { httpConnectorAuthority, httpCredentialAuthorized } from './http-connector-authority';
import type { InferenceAuthContext } from './auth';
import type { ConnectorAuthority, ConnectorFamily } from './self-discovery';
import { readInferencePrincipal } from './route-discovery-store';

interface ConnectorDiagnostic {
  provider: string;
  family: ConnectorFamily;
  configured: boolean;
  configurationStatus: 'configured' | 'not-configured' | 'not-disclosed';
  ownerDid: string;
  authority: ConnectorAuthority | null;
  grantStatus: 'granted' | 'denied' | 'not-evaluated';
  usable: boolean | null;
  usableModels: string[];
  authorizedScopes: string[];
  credentialStatus: 'not-probed';
  reason?: { code: string; message: string };
  fix?: { control: string; href: string; actingDid: string };
}

function actor(context: InferenceAuthContext) {
  return context.caller?.actorDid ?? context.orgContext?.memberDid ?? context.ownerDid;
}
function tokenAllows(context: InferenceAuthContext, scope: string) {
  return !context.appDid || context.toolAuth?.scopes.includes(scope) === true;
}
function diagnostic(provider: string, family: ConnectorFamily, ownerDid: string, configured: boolean): ConnectorDiagnostic {
  return {
    provider, family, ownerDid, configured,
    configurationStatus: configured ? 'configured' : 'not-configured',
    authority: null, grantStatus: 'denied', usable: false, usableModels: [], authorizedScopes: [],
    credentialStatus: 'not-probed',
  };
}
function deny(row: ConnectorDiagnostic, code: string, actingDid = row.ownerDid) {
  const controls: Record<string, { control: string; href: string }> = {
    agent_not_assigned: { control: 'Agents → assignment and allowed services', href: '/auth/agents' },
    service_not_allowed: { control: 'Agents → assignment and allowed services', href: '/auth/agents' },
    org_membership_required: { control: 'Members', href: '/auth/members' },
    org_grant_required: {
      control: 'Org service keys → Member grants → Grant',
      href: `/auth/connectors#org-connector-${encodeURIComponent(row.provider)}-grants`,
    },
    identity_inactive: { control: 'Identity and members → active standing', href: '/auth/members' },
    connection_suspended: { control: 'Members → External connections → Resume service/connection', href: '/auth/members' },
  };
  return {
    ...row, usable: false, grantStatus: 'denied' as const,
    reason: { code, message: 'Tool authorization unavailable; use the indicated control to restore access.' },
    fix: {
      ...(controls[code] ?? {
        control: 'Connector → credential and scope grants',
        href: CONNECTOR_REGISTRY.some(entry => entry.id === row.provider)
          ? `/auth/connectors/${encodeURIComponent(row.provider)}` : '/auth/connectors',
      }),
      actingDid,
    },
  };
}

/** The authorization result is not a claim about provider acceptance or ciphertext integrity. */
export async function discoveryExternalConnection(
  context: InferenceAuthContext, target: MemberConnectionTarget, family: ConnectorFamily,
) {
  const actorDid = actor(context);
  const caller = externalConnectionCaller(context, target);
  const ownerDid = caller.caller?.actingAs ?? caller.caller?.actingFor ?? actorDid;
  const row = diagnostic(target.provider, family, ownerDid, false);
  row.configurationStatus = 'not-disclosed';
  if (!tokenAllows(context, target.scope)) return deny(row, 'tool_scope_required');
  try {
    const access = await authorizeExternalMcpAccess(db, caller, target);
    const principal = caller.caller
      ? await resolveConnectionPrincipal(caller.caller, target.service ?? 'connections') : undefined;
    const orgContext = principal?.orgContext;
    let authority: ConnectorAuthority = access.row.ownerDid === actorDid ? 'own-key' : 'delegated';
    if (orgContext) authority = orgContext.assignedAgentDid ? 'org-held' : 'member-grant';
    const authorized = {
      ...row, ownerDid: access.row.ownerDid, configured: true, configurationStatus: 'configured' as const,
      authority,
      grantStatus: 'granted' as const, usable: true, authorizedScopes: [target.scope],
    };
    return access.custodyId ? authorized : deny(authorized, 'credential_unavailable');
  } catch (error) {
    if (!(error instanceof ExternalMcpError) || error.status !== 403) throw error;
    return deny(row, error.code ?? 'tool_scope_required', error.fixActingDid);
  }
}
function externalConnectionCaller(context: InferenceAuthContext, target: MemberConnectionTarget): ExternalMcpCaller {
  const memberDid = actor(context);
  // Exactly the envelope used by requireAgentKey, invocationCaller and appUpstreamRoute.
  if (target.service === 'warp') return { memberDid, caller: context.caller };
  return {
    memberDid, appDid: context.appDid, serviceToken: context.toolAuth?.serviceToken,
    ...(context.toolAuth?.serviceToken ? {} : { caller: context.caller }),
  };
}

function connectionAuthority(context: InferenceAuthContext, ownerDid: string): ConnectorAuthority {
  // Org-held/member-grant lanes return through discoveryExternalConnection.
  return ownerDid === actor(context) ? 'own-key' : 'delegated';
}

async function httpRow(context: InferenceAuthContext, entry: ConnectorEntry, configured: boolean) {
  const actorDid = actor(context);
  const row = diagnostic(entry.id, entry.id === 'mcp' ? 'mcp' : 'http', actorDid, configured);
  const scopes = entry.scopes.filter(scope => tokenAllows(context, scope.name));
  if (scopes.length === 0) return deny(row, 'tool_scope_required');
  if (entry.id === 'warp' && context.caller) {
    const principal = await resolveConnectionPrincipal(context.caller, 'warp');
    if (principal.orgContext) return discoveryExternalConnection(context, {
      provider: 'warp', scope: 'warp:dispatch', service: 'warp',
    }, 'http');
    row.ownerDid = principal.ownerDid;
    if (row.ownerDid !== actorDid) {
      row.configured = false;
      row.configurationStatus = 'not-disclosed';
    }
  }
  const authority = entry.id === 'mcp' ? undefined : await httpConnectorAuthority(entry.id);
  if (!authority && entry.id !== 'mcp') return {
    ...row, grantStatus: 'not-evaluated' as const, usable: null,
    fix: { control: 'Connectors → configuration and grants', href: '/auth/connectors', actingDid: actorDid },
  };
  row.authorizedScopes = await authorizedScopes(scopes, scope => entry.id === 'mcp'
    ? resolveActiveMcpGrant(actorDid, scope, context.appDid)
    : authority!.grant(row.ownerDid, scope));
  if (row.authorizedScopes.length === 0) return deny(row, 'tool_scope_required');
  row.authority = connectionAuthority(context, row.ownerDid);
  row.grantStatus = 'granted';
  if (authority && !await httpCredentialAuthorized(authority, row.ownerDid)) return deny(row, 'credential_unavailable');
  // Live scope/custody metadata is authoritative; the installation registry is a shadow.
  row.configured = true;
  row.configurationStatus = 'configured';
  row.usable = true;
  return row;
}
async function authorizedScopes(scopes: ConnectorEntry['scopes'], grant: (scope: string) => Promise<boolean>) {
  const allowed: string[] = [];
  await forEachSequential(scopes, async scope => {
    if (await grant(scope.name)) allowed.push(scope.name);
  });
  return allowed;
}

async function safeHttpRow(context: InferenceAuthContext, entry: ConnectorEntry, configured: boolean) {
  try { return await httpRow(context, entry, configured); }
  catch (error) {
    if (!(error instanceof ExternalMcpError) || error.status !== 403) throw error;
    const actorDid = actor(context);
    const ownerDid = entry.id === 'warp' ? context.ownerDid : actorDid;
    const row = diagnostic(entry.id, 'http', ownerDid, ownerDid === actorDid && configured);
    if (ownerDid !== actorDid) row.configurationStatus = 'not-disclosed';
    return deny(row, error.code ?? 'tool_scope_required');
  }
}

async function upstreamRow(context: InferenceAuthContext & { appDid: string }, upstream: AppUpstream) {
  const scopes = new Set(upstream.paths.flatMap(path => path.methods.map(method =>
    ['GET', 'HEAD'].includes(method) ? UPSTREAM_READ_SCOPE : UPSTREAM_WRITE_SCOPE)));
  const results: ConnectorDiagnostic[] = [];
  await forEachSequential(scopes, async scope => {
    if (!tokenAllows(context, scope)) return;
    results.push(await discoveryExternalConnection(context, {
      provider: upstreamProvider(context.appDid, upstream.id),
      binding: upstreamBinding(context.appDid, upstream), scope,
    }, 'http'));
  });
  const usable = results.filter(row => row.usable);
  const selected = usable.at(0) ?? results.at(0);
  if (!selected) return deny(diagnostic(upstreamProvider(context.appDid, upstream.id), 'http', actor(context), false), 'tool_scope_required');
  return { ...selected, authorizedScopes: usable.flatMap(row => row.authorizedScopes) };
}

async function upstreamRows(context: InferenceAuthContext) {
  if (!context.appDid || !context.toolAuth?.serviceToken) return [];
  // appUpstreamRoute requires read scope before invokeAppUpstream checks read/write.
  if (!tokenAllows(context, UPSTREAM_READ_SCOPE)) return [];
  const appDid = context.appDid;
  // Only the authenticated app's declared catalogue, never a principal's private upstream enumeration.
  try {
    const app = await requireConnectionApp(db, appDid, UPSTREAM_READ_SCOPE, true);
    const { upstreams } = parseUpstream(upstreamDeclarations, { upstreams: app.upstreams });
    const rows: ConnectorDiagnostic[] = [];
    await forEachSequential(upstreams, async upstream => {
      rows.push(await upstreamRow({ ...context, appDid }, upstream));
    });
    return rows;
  } catch (error) {
    if (!(error instanceof ExternalMcpError) || error.status !== 403) throw error;
    return [deny(diagnostic('app-upstream', 'http', actor(context), false), 'tool_scope_required')];
  }
}

/** Never invokes a credential loader, vault get/peek, unseal, or provider request. */
export async function listDiscoveryConnectorMetadata(context: InferenceAuthContext) {
  const actorDid = actor(context);
  const registrations = await listConnectorRegistrations(actorDid);
  const brains = new Set<string>(listBrainConnectors());
  const rows: ConnectorDiagnostic[] = [];
  await forEachSequential(CONNECTOR_REGISTRY, async entry => {
    if (brains.has(entry.id)) return;
    const configured = registrations.some(row => row.provider === entry.id && row.status === 'active' && !row.revokedAt);
    rows.push(await safeHttpRow(context, entry, configured));
  });
  rows.push(
    await discoveryExternalConnection(context, POSTMAN_CONNECTION, 'mcp'),
    ...await upstreamRows(context),
  );
  const known = new Set([...brains, ...rows.map(row => row.provider)]);
  for (const registration of registrations) {
    if (known.has(registration.provider)
      || registration.provider.startsWith('app-upstream:') || registration.provider.endsWith('-billing')) continue;
    const owner = await readInferencePrincipal(registration.ownerDid);
    // Org-owned credentials are projected through the authorized org lanes, never as personal fallbacks.
    if (!owner || isOrgScope(owner.scope)) continue;
    known.add(registration.provider);
    rows.push({
      ...diagnostic(registration.provider, 'http', actorDid, registration.status === 'active' && !registration.revokedAt),
      grantStatus: 'not-evaluated', usable: null,
      fix: { control: 'Connectors → configuration and grants', href: '/auth/connectors', actingDid: actorDid },
    });
  }
  return rows;
}
