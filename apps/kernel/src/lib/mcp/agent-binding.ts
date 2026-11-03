import { and, eq, isNull } from 'drizzle-orm';
import { db, attestations, identities, identityMembers } from '@/src/db';
import { listServiceOf } from '@/src/lib/auth/agent-service';
import { isLiveAppAuthorization } from '@/src/lib/auth/live-app-authorization';
import { isOrgScope } from '@/src/lib/kernel/connection-principal-policy';
import { resolveConnectionPrincipal } from '@/src/lib/kernel/connection-principal';
import type { AppTokenPayload } from '@/src/lib/auth/jwt';
import type { McpToolContext } from './types';
import type { ConnectionCaller } from '@/src/lib/kernel/connection-principal-policy';

/** Signed consent context, not a gateway identity or a per-request selector. */
export interface AgentOAuthBinding {
  agentDid: string;
  principalDid: string;
  consentedByDid: string;
}

export class AgentOAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) {
    super(message);
    this.name = 'AgentOAuthError';
  }
}

const assignmentRequired = () => new AgentOAuthError('agent_assignment_required',
  'Restore the agent assignment on /auth/agents, then consent again.');
const authorizationRequired = () => new AgentOAuthError('agent_authorization_required',
  'Restore this agent’s OAuth authorization on /jin → Grants, then consent again.');

async function activeIdentity(did: string) {
  const [identity] = await db.select().from(identities).where(and(
    eq(identities.id, did), isNull(identities.suspendedAt),
  )).limit(1);
  return identity;
}

async function mayConsent(principalDid: string, consenterDid: string): Promise<boolean> {
  const principal = await activeIdentity(principalDid);
  if (!principal) return false;
  if (!isOrgScope(principal.scope)) {
    return principal.scope === 'actor' && principal.subtype === 'human' && principalDid === consenterDid;
  }
  const [membership] = await db.select().from(identityMembers).where(and(
    eq(identityMembers.identityDid, principalDid), eq(identityMembers.memberDid, consenterDid),
    isNull(identityMembers.removedAt),
  )).limit(1);
  return !!membership && ['owner', 'admin'].includes(membership.role)
    && (membership.allowedServices === null || membership.allowedServices.includes('connections'));
}

/** Only this human's personal agent or an org bot they administer is offered. */
export async function agentConsentChoices(agentDid: string, consenterDid: string) {
  const [agent, human] = await Promise.all([activeIdentity(agentDid), activeIdentity(consenterDid)]);
  if (agent?.scope !== 'actor' || agent.subtype !== 'agent') throw assignmentRequired();
  if (human?.scope !== 'actor' || human.subtype !== 'human') {
    throw new AgentOAuthError('agent_consent_forbidden', 'Sign in as the assigned human or an org admin to consent.');
  }
  const principals = await listServiceOf(agentDid);
  if (principals.length === 0) throw assignmentRequired();
  const choices: Array<{ did: string; handle: string | null; name: string | null }> = [];
  for (const did of principals) {
    if (!await mayConsent(did, consenterDid)) continue;
    const identity = await activeIdentity(did);
    if (identity) choices.push({ did, handle: identity.handle, name: identity.name });
  }
  if (choices.length === 0) {
    throw new AgentOAuthError('agent_consent_forbidden', 'Only the assigned human or an org admin can consent on /auth/authorize.');
  }
  return { agent: { did: agent.id, handle: agent.handle, name: agent.name }, principals: choices };
}

export async function approveAgentBinding(
  agentDid: unknown, principalDid: unknown, consentedByDid: string,
): Promise<AgentOAuthBinding> {
  if (typeof agentDid !== 'string' || !agentDid || typeof principalDid !== 'string' || !principalDid) {
    throw new AgentOAuthError('agent_binding_required', 'Explicitly select an agent DID and its assigned DID on the consent screen.', 400);
  }
  const choices = await agentConsentChoices(agentDid, consentedByDid);
  if (!choices.principals.some(principal => principal.did === principalDid)) {
    throw new AgentOAuthError('agent_binding_invalid', 'Select an assigned DID you control on /auth/authorize.', 403);
  }
  return { agentDid, principalDid, consentedByDid };
}

/** A malformed stored binding must never silently downgrade to human OAuth. */
export function readAgentBinding(payload: unknown): AgentOAuthBinding | undefined {
  const value = (payload as { agentBinding?: unknown } | null)?.agentBinding;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw authorizationRequired();
  const binding = value as Partial<AgentOAuthBinding>;
  if (![binding.agentDid, binding.principalDid, binding.consentedByDid]
    .every(did => typeof did === 'string' && /^did:[a-z0-9]+:[^\s]+$/.test(did))) throw authorizationRequired();
  return binding as AgentOAuthBinding;
}

/** Code redemption and refresh read exactly the binding signed at consent. */
export async function oauthAgentBinding(
  authorizationId: string, agentDid: string, appDid: string, scope?: string,
): Promise<AgentOAuthBinding | undefined> {
  const [authorization] = await db.select().from(attestations).where(eq(attestations.id, authorizationId)).limit(1);
  const binding = readAgentBinding(authorization?.payload);
  if (!binding) return undefined;
  if (!authorization || !isLiveAppAuthorization(authorization)
    || authorization.type !== 'app.authorized' || authorization.issuerDid !== agentDid
    || authorization.subjectDid !== appDid || binding.agentDid !== agentDid) throw authorizationRequired();
  if (!new Set(await listServiceOf(agentDid)).has(binding.principalDid)) throw assignmentRequired();
  if (scope !== undefined) {
    const granted = (authorization.payload as { scopes?: unknown }).scopes;
    if (!Array.isArray(granted) || scope.split(/\s+/).filter(Boolean).some(value => !granted.includes(value))) {
      throw authorizationRequired();
    }
  }
  return binding;
}

async function requireBoundAuthorization(ctx: McpToolContext) {
  if (!ctx.actingFor || !ctx.authorizationId) throw authorizationRequired();
  const binding = await oauthAgentBinding(ctx.authorizationId, ctx.did, ctx.appDid, [...ctx.scopes].join(' '));
  if (!binding || binding.principalDid !== ctx.actingFor) throw authorizationRequired();
  return binding;
}

/** Assignment is live, not whatever membership happened to exist at mint. */
async function boundConnection(binding: AgentOAuthBinding, service: string) {
  const principals = new Set(await listServiceOf(binding.agentDid));
  if (!principals.has(binding.principalDid)) throw assignmentRequired();
  const principal = await activeIdentity(binding.principalDid);
  if (!principal) throw assignmentRequired();
  const caller = {
    actorDid: binding.agentDid,
    ...(isOrgScope(principal.scope) ? { actingAs: binding.principalDid } : { actingFor: binding.principalDid }),
  };
  try {
    const connection = await resolveConnectionPrincipal(caller, service);
    return { ...connection, caller };
  } catch {
    throw new AgentOAuthError('agent_service_not_allowed',
      `Restore the agent assignment and ${service} service access on /auth/agents.`);
  }
}

/** Reused before each MCP credential access; custody remains in the connector. */
export async function mcpCredentialContext(ctx: McpToolContext, service: string): Promise<{
  ownerDid: string; caller?: ConnectionCaller;
}> {
  if (!ctx.actingFor) return { ownerDid: ctx.did };
  return boundConnection(await requireBoundAuthorization(ctx), service);
}

/** Legacy human consent stays unchanged; an agent cannot use an unbound token. */
export async function mcpOAuthContext(payload: AppTokenPayload): Promise<McpToolContext> {
  const ctx: McpToolContext = {
    did: payload.sub, appDid: payload.azp, scopes: new Set(payload.scope.split(/\s+/).filter(Boolean)),
  };
  if (!payload.actingFor) {
    const identity = await activeIdentity(payload.sub);
    if (identity?.subtype === 'agent') throw authorizationRequired();
    return ctx;
  }
  ctx.actingFor = payload.actingFor;
  ctx.authorizationId = payload.attestationId;
  const binding = await requireBoundAuthorization(ctx);
  if (binding.agentDid !== ctx.did) throw authorizationRequired();
  return ctx;
}
