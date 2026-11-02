import { and, eq, gt, isNull } from 'drizzle-orm';
import { audienceAllows, isDelegationAudience } from '@imajin/auth';
import { db, identities, identityMembers, delegationGrants } from '@/src/db';
import { connectorRegistryId, readConnectorRegistration } from '@/src/lib/kernel/connector-registry-store';
import type { BrainConnectorId, BrainCredentialContext } from './brain';
import type {
  DiscoveryCaller, DiscoveryContext, InferenceRoute, InferenceRouteCandidate, InferenceRouteKind,
} from './route-discovery';

const orgScope = (scope: string) => ['business', 'community', 'family'].includes(scope);
function selectorsFor(kind: InferenceRouteKind, principalDid: string): InferenceRoute['selectors'] {
  if (kind === 'own') return {};
  return kind === 'B' ? { actingFor: principalDid } : { actingAs: principalDid };
}

async function readPrincipal(did: string) {
  const [identity] = await db.select({
    did: identities.id, handle: identities.handle, scope: identities.scope, subtype: identities.subtype,
  }).from(identities).where(and(eq(identities.id, did), isNull(identities.suspendedAt))).limit(1);
  return identity;
}

/** Relationships bound to this signer only; these are candidates, never authorization. */
async function relatedPrincipals(actorDid: string, agent: boolean): Promise<string[]> {
  const memberships = await db.select({
    did: identityMembers.identityDid, role: identityMembers.role,
  }).from(identityMembers).where(and(
    eq(identityMembers.memberDid, actorDid), isNull(identityMembers.removedAt),
  ));
  const dids = new Set(memberships.filter(row => !agent || row.role === 'agent').map(row => row.did));
  if (agent) {
    const grants = await db.select({
      did: delegationGrants.delegatorDid, audience: delegationGrants.audience,
    }).from(delegationGrants).where(and(
      eq(delegationGrants.agentDid, actorDid), eq(delegationGrants.status, 'active'),
      isNull(delegationGrants.revokedAt), gt(delegationGrants.expiresAt, new Date()),
    ));
    for (const grant of grants) {
      if (isDelegationAudience(grant.audience) && audienceAllows(grant.audience, grant.did)) dids.add(grant.did);
    }
  }
  return [...dids];
}

function candidateContext(
  actorDid: string,
  principalDid: string,
  kind: InferenceRouteKind,
  selected: DiscoveryContext,
): { context: BrainCredentialContext; selectors: InferenceRoute['selectors'] } {
  if (principalDid === selected.ownerDid) {
    const caller = selected.caller;
    return {
      context: selected,
      selectors: {
        ...(caller?.actingAs ? { actingAs: caller.actingAs } : {}),
        ...(caller?.actingFor ? { actingFor: caller.actingFor } : {}),
        ...(!caller && selected.orgContext ? { actingAs: selected.orgContext.orgDid } : {}),
      },
    };
  }
  const selectors = selectorsFor(kind, principalDid);
  const caller: DiscoveryCaller = { actorDid, ...selectors };
  // Extra caller data is consumed by #3182's resolver after that policy lands.
  const context: BrainCredentialContext & { caller: DiscoveryCaller } = { ownerDid: principalDid, caller };
  if (kind === 'C') context.orgContext = { memberDid: actorDid, orgDid: principalDid };
  return { context, selectors };
}

type Principal = NonNullable<Awaited<ReturnType<typeof readPrincipal>>>;

function makeCandidate(actor: Principal, principal: Principal, selected: DiscoveryContext): InferenceRouteCandidate | undefined {
  const agent = actor.subtype === 'agent';
  const isOrg = orgScope(principal.scope);
  const own = principal.did === actor.did;
  if (!own && !agent && !isOrg) return undefined;
  let kind: InferenceRouteKind = 'own';
  if (!own) kind = agent ? 'B' : 'C';
  if (!own && agent && isOrg) kind = 'A';
  const route = candidateContext(actor.did, principal.did, kind, selected);
  // On the pre-#3182 base, resolveBrain ignores fabricated caller contexts.
  // Never turn enumeration into an unverified assignment/credential read.
  const pending = agent && !own && !selected.caller && principal.did !== selected.ownerDid;
  return {
    kind, principal: { did: principal.did, handle: principal.handle }, memberDid: actor.did,
    ...route, orgHeld: kind === 'C' || kind === 'A',
    ...(pending ? { pendingAssignmentResolver: true } : {}),
  };
}

export async function loadInferenceRouteCandidates(selected: DiscoveryContext): Promise<InferenceRouteCandidate[]> {
  const actorDid = selected.caller?.actorDid ?? selected.orgContext?.memberDid ?? selected.ownerDid;
  const actor = await readPrincipal(actorDid);
  if (!actor) return [];
  const agent = actor.subtype === 'agent';
  const dids = new Set([actorDid, selected.ownerDid, ...await relatedPrincipals(actorDid, agent)]);
  const candidates: InferenceRouteCandidate[] = [];
  for (const did of dids) {
    const principal = did === actorDid ? actor : await readPrincipal(did);
    if (!principal) continue;
    const candidate = makeCandidate(actor, principal, selected);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/** Return identity metadata only. Never project a registry row or its vault field wholesale. */
export async function readInferenceCard(did: string, provider: BrainConnectorId, orgHeld: boolean) {
  const registryProvider = orgHeld ? `org-held-${provider}` : provider;
  const row = await readConnectorRegistration(did, registryProvider, 'primary');
  return {
    provider,
    id: row?.id ?? connectorRegistryId(did, registryProvider, 'primary'),
    label: row?.label ?? `${provider} · primary`,
  };
}
