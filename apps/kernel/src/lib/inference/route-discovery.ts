import { resolveBrain, listBrainConnectors, NoBrainSealedError, NoModelSelectedError } from './brain';
import type { BrainConnectorId, BrainCredentialContext } from './brain';
import type { InferenceAuthContext } from './auth';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
import { loadInferenceRouteCandidates, readInferenceCard } from './route-discovery-store';

export type InferenceRouteKind = 'own' | 'A' | 'B' | 'C';
export type InferenceRouteReason =
  | 'no_grant' | 'no_model_selected' | 'not_a_member' | 'agent_member_chain_unsupported'
  | 'key_not_loaded' | 'not_authorized' | 'route_unavailable';

export interface InferenceRoute {
  kind: InferenceRouteKind;
  billedPrincipal: { did: string; handle: string | null };
  card: { provider: BrainConnectorId; id: string; label: string; loaded: boolean };
  selectedModels: string[];
  usable: boolean;
  reason?: { code: InferenceRouteReason; message: string };
  selectors: { actingAs?: string; actingFor?: string };
}

/** Structural compatibility with the verified caller context introduced by #3182. */
export interface DiscoveryCaller { actorDid: string; actingAs?: string; actingFor?: string }
export type DiscoveryContext = InferenceAuthContext & { caller?: DiscoveryCaller };
export interface InferenceRouteCandidate {
  kind: InferenceRouteKind;
  principal: InferenceRoute['billedPrincipal'];
  memberDid?: string;
  selectors: InferenceRoute['selectors'];
  context: BrainCredentialContext;
  orgHeld: boolean;
  pendingAssignmentResolver?: boolean;
}
export interface InferenceCardResolution {
  loaded: boolean;
  modelId?: string;
  denied?: InferenceRouteReason;
}

function principalName(principal: InferenceRoute['billedPrincipal']): string {
  return principal.handle ? `@${principal.handle} (${principal.did})` : principal.did;
}

function reasonMessage(code: InferenceRouteReason, candidate: InferenceRouteCandidate, provider: string): string {
  const principal = principalName(candidate.principal);
  switch (code) {
    case 'no_grant': return `No grant for ${candidate.memberDid ?? 'member'} on ${principal} ${provider}`;
    case 'no_model_selected': return `${principal} ${provider} card has no model selected`;
    case 'not_a_member': return `${candidate.memberDid ?? 'Caller'} is not a member of ${principal}`;
    case 'agent_member_chain_unsupported': return 'Agent → member chain not supported yet (#3182)';
    case 'key_not_loaded': return `${principal} ${provider} key not loaded`;
    case 'not_authorized': return `Caller is not authorized for ${principal} ${provider}; check assignment and allowed services`;
    case 'route_unavailable': return `${principal} ${provider} route is unavailable`;
  }
}

/** Pure, allowlisted projection. No credential or vault-reference field is accepted. */
export function describeInferenceRoute(
  candidate: InferenceRouteCandidate,
  card: Omit<InferenceRoute['card'], 'loaded'>,
  resolution: InferenceCardResolution,
): InferenceRoute {
  const code = resolution.denied ?? (!resolution.loaded ? 'key_not_loaded' : undefined)
    ?? (!resolution.modelId ? 'no_model_selected' : undefined);
  return {
    kind: candidate.kind,
    billedPrincipal: { did: candidate.principal.did, handle: candidate.principal.handle },
    card: { provider: card.provider, id: card.id, label: card.label, loaded: resolution.loaded },
    selectedModels: resolution.modelId ? [resolution.modelId] : [],
    usable: code === undefined,
    ...(code ? { reason: { code, message: reasonMessage(code, candidate, card.provider) } } : {}),
    selectors: { ...candidate.selectors },
  };
}

/** Never forward an exception message: custody and upstream errors may contain key material. */
function rejectedResolution(error: unknown): InferenceCardResolution {
  if (error instanceof NoModelSelectedError) return { loaded: true };
  if (error instanceof NoBrainSealedError) return { loaded: false };
  if (!(error instanceof ExternalMcpError)) return { loaded: false, denied: 'route_unavailable' };
  const message = error.message.toLowerCase();
  if (message.includes('member grant required')) return { loaded: false, denied: 'no_grant' };
  if (message.includes('not a member')) return { loaded: false, denied: 'not_a_member' };
  if (message.includes('chain') && message.includes('not supported')) {
    return { loaded: false, denied: 'agent_member_chain_unsupported' };
  }
  return { loaded: false, denied: error.status === 403 ? 'not_authorized' : 'key_not_loaded' };
}

async function resolveCard(candidate: InferenceRouteCandidate, provider: BrainConnectorId): Promise<InferenceCardResolution> {
  if (candidate.pendingAssignmentResolver) return { loaded: false, denied: 'not_authorized' };
  try {
    // The same resolver used by /infer/v1/chat/completions. Discovery never implements a grant/assignment gate.
    const brain = await resolveBrain(candidate.context, { connectors: [provider] });
    if (brain.credentialDid !== candidate.principal.did || brain.connector !== provider) {
      return { loaded: false, denied: 'route_unavailable' };
    }
    return { loaded: true, modelId: brain.modelId };
  } catch (error) {
    return rejectedResolution(error);
  }
}

/** Enumerate only held relationships; re-evaluate each route through the call resolver, without caching authority. */
export async function listInferenceRoutes(context: DiscoveryContext): Promise<InferenceRoute[]> {
  const candidates = await loadInferenceRouteCandidates(context);
  const routes: InferenceRoute[] = [];
  // Sequential: the existing resolver uses custody locks and provider-priority ordering.
  for (const candidate of candidates) {
    const providers = candidate.orgHeld ? ['anthropic'] as const : listBrainConnectors();
    for (const provider of providers) {
      const card = await readInferenceCard(candidate.principal.did, provider, candidate.orgHeld);
      const resolution = await resolveCard(candidate, provider);
      routes.push(describeInferenceRoute(candidate, card, resolution));
    }
  }
  return routes;
}
