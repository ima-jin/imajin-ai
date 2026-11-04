import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, identities, identityMembers, delegationGrants } from '@/src/db';
import { connectorRegistryId, readConnectorRegistration } from '@/src/lib/kernel/connector-registry-store';
import { requireAgentAssignment, resolveConnectionPrincipal } from '@/src/lib/kernel/connection-principal';
import { isOrgScope, type ConnectionCaller } from '@/src/lib/kernel/connection-principal-policy';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
import { forEachSequential } from '@/src/lib/async/sequential';
import { resolveInferenceRouteContext } from './route-context';
import type { BrainConnectorId } from './brain';
import type { DiscoveryContext, InferenceRouteCandidate, InferenceRouteKind } from './route-discovery';

export async function readInferencePrincipal(did: string) {
  const [identity] = await db.select({
    did: identities.id, handle: identities.handle, scope: identities.scope, subtype: identities.subtype, tier: identities.tier,
  }).from(identities).where(and(eq(identities.id, did), isNull(identities.suspendedAt))).limit(1);
  return identity;
}
type Principal = NonNullable<Awaited<ReturnType<typeof readInferencePrincipal>>>;

/** Query only relationships held by this caller; canonical assignment checks decide service access. */
async function relatedPrincipals(actorDid: string, agent: boolean): Promise<string[]> {
  const memberships = await db.select({
    did: identityMembers.identityDid, role: identityMembers.role,
  }).from(identityMembers).where(and(
    eq(identityMembers.memberDid, actorDid), isNull(identityMembers.removedAt),
  ));
  const dids = new Set(memberships.filter(row => !agent || row.role === 'agent').map(row => row.did));
  if (!agent) return [...dids];
  const grants = await db.select({ did: delegationGrants.delegatorDid }).from(delegationGrants).where(and(
    eq(delegationGrants.agentDid, actorDid), eq(delegationGrants.status, 'active'),
    isNull(delegationGrants.revokedAt), gt(delegationGrants.expiresAt, new Date()),
  ));
  for (const grant of grants) dids.add(grant.did);
  const held: string[] = [];
  await forEachSequential(dids, async did => {
    try {
      await requireAgentAssignment(db, actorDid, did, 'infer');
      held.push(did);
    } catch (error) {
      // A held assignment excluded from inference is visible as an unusable row.
      // Revoked/expired/wrong-audience delegations are not held and reveal nothing.
      if (error instanceof ExternalMcpError && error.code === 'service_not_allowed') held.push(did);
      else if (!(error instanceof ExternalMcpError)) throw error;
    }
  });
  return held;
}

function routeKind(actor: Principal, principal: Principal, caller: ConnectionCaller): InferenceRouteKind {
  if (principal.did === actor.did) return 'own';
  if (actor.subtype !== 'agent' || (caller.actingFor && caller.actingFor !== principal.did)) return 'C';
  return isOrgScope(principal.scope) ? 'A' : 'B';
}

async function makeCandidate(actor: Principal, principal: Principal, caller: ConnectionCaller, selected: DiscoveryContext) {
  if (principal.did !== actor.did && actor.subtype !== 'agent' && !isOrgScope(principal.scope)) return undefined;
  const route = resolveInferenceRouteContext({ caller, appDid: selected.appDid });
  let authorizationError: ExternalMcpError | undefined;
  try {
    await resolveConnectionPrincipal(caller, 'infer');
  } catch (error) {
    if (!(error instanceof ExternalMcpError)) throw error;
    authorizationError = error;
  }
  const kind = routeKind(actor, principal, caller);
  return {
    kind, principal: { did: principal.did, handle: principal.handle },
    memberDid: caller.actingFor ?? actor.did,
    selectors: {
      ...(caller.actingAs ? { actingAs: caller.actingAs } : {}),
      ...(caller.actingFor ? { actingFor: caller.actingFor } : {}),
    },
    context: route.context, orgHeld: kind === 'C' || kind === 'A', authorizationError,
  } satisfies InferenceRouteCandidate;
}

function directCaller(actor: Principal, principal: Principal): ConnectionCaller {
  if (actor.did === principal.did) return { actorDid: actor.did };
  return {
    actorDid: actor.did,
    ...(isOrgScope(principal.scope) ? { actingAs: principal.did } : { actingFor: principal.did }),
  };
}

async function memberOrgCandidates(actor: Principal, member: InferenceRouteCandidate, selected: DiscoveryContext) {
  // A service-excluded human assignment must not reveal that human's other relationships.
  if (member.authorizationError) return [];
  const dids = new Set(await relatedPrincipals(member.principal.did, false));
  if (selected.caller?.actingFor === member.principal.did && selected.caller.actingAs) dids.add(selected.caller.actingAs);
  const candidates: InferenceRouteCandidate[] = [];
  await forEachSequential(dids, async did => {
    const principal = await readInferencePrincipal(did);
    if (!principal || !isOrgScope(principal.scope)) return;
    const candidate = await makeCandidate(actor, principal, {
      actorDid: actor.did, actingFor: member.principal.did, actingAs: did,
    }, selected);
    if (candidate) candidates.push(candidate);
  });
  return candidates;
}

export async function loadInferenceRouteCandidates(selected: DiscoveryContext): Promise<InferenceRouteCandidate[]> {
  const actorDid = selected.caller?.actorDid ?? selected.orgContext?.memberDid ?? selected.ownerDid;
  const actor = await readInferencePrincipal(actorDid);
  if (!actor) return [];
  const selectedPrincipal = selected.caller?.actingFor ?? selected.caller?.actingAs ?? selected.ownerDid;
  const dids = new Set([actorDid, selectedPrincipal, ...await relatedPrincipals(actorDid, actor.subtype === 'agent')]);
  const candidates: InferenceRouteCandidate[] = [];
  await forEachSequential(dids, async did => {
    const principal = did === actorDid ? actor : await readInferencePrincipal(did);
    if (!principal) return;
    const candidate = await makeCandidate(actor, principal, directCaller(actor, principal), selected);
    if (candidate) candidates.push(candidate);
  });
  await forEachSequential(candidates, async member => {
    if (member.kind === 'B') candidates.push(...await memberOrgCandidates(actor, member, selected));
  });
  return candidates;
}

/** Project card metadata only, never a complete registry row or credential reference. */
export async function readInferenceCard(did: string, provider: BrainConnectorId, orgHeld: boolean) {
  const registryProvider = orgHeld ? `org-held-${provider}` : provider;
  const row = await readConnectorRegistration(did, registryProvider, 'primary');
  return { provider, id: row?.id ?? connectorRegistryId(did, registryProvider, 'primary'), label: row?.label ?? `${provider} · primary` };
}
