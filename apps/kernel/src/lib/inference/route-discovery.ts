import { resolveBrain, listBrainConnectors, NoBrainSealedError, NoModelSelectedError } from './brain';
import type { BrainConnectorId } from './brain';
import { inferenceBrainContext } from './route-context';
import type { InferenceAuthContext } from './auth';
import { ExternalMcpError, type ConnectionErrorCode } from '@/src/lib/kernel/external-mcp-policy';
import { loadInferenceRouteCandidates, readInferenceCard } from './route-discovery-store';

export type InferenceRouteKind = 'own' | 'A' | 'B' | 'C';
export type InferenceRouteReason =
  | 'no_grant' | 'no_model_selected' | 'not_a_member'
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

export type DiscoveryContext = InferenceAuthContext;
export interface InferenceRouteCandidate {
  kind: InferenceRouteKind;
  principal: InferenceRoute['billedPrincipal'];
  memberDid?: string;
  selectors: InferenceRoute['selectors'];
  context: InferenceAuthContext;
  orgHeld: boolean;
  authorizationError?: ExternalMcpError;
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
    selectors: {
      ...(candidate.selectors.actingAs ? { actingAs: candidate.selectors.actingAs } : {}),
      ...(candidate.selectors.actingFor ? { actingFor: candidate.selectors.actingFor } : {}),
    },
  };
}

/** Never forward an exception message: custody and upstream errors may contain key material. */
const CONNECTION_REASONS: Record<ConnectionErrorCode, InferenceRouteReason> = {
  agent_not_assigned: 'not_authorized', service_not_allowed: 'not_authorized', identity_inactive: 'not_authorized',
  org_membership_required: 'not_a_member', org_grant_required: 'no_grant',
  connection_not_loaded: 'key_not_loaded', connection_suspended: 'not_authorized', credential_unavailable: 'key_not_loaded',
};
function rejectedResolution(error: unknown): InferenceCardResolution {
  if (error instanceof NoModelSelectedError) return { loaded: true };
  if (error instanceof NoBrainSealedError) return { loaded: false };
  if (!(error instanceof ExternalMcpError)) return { loaded: false, denied: 'route_unavailable' };
  return { loaded: false, denied: error.code ? CONNECTION_REASONS[error.code] : 'route_unavailable' };
}

async function resolveCard(candidate: InferenceRouteCandidate, provider: BrainConnectorId, model?: string): Promise<InferenceCardResolution> {
  if (candidate.authorizationError) return rejectedResolution(candidate.authorizationError);
  try {
    // The same resolver used by /infer/v1/chat/completions. Discovery never implements a grant/assignment gate.
    const brain = await resolveBrain(inferenceBrainContext(candidate.context), { connectors: [provider], ...(model ? { model } : {}) });
    if (brain.credentialDid !== candidate.principal.did || brain.connector !== provider) {
      return { loaded: false, denied: 'route_unavailable' };
    }
    return { loaded: true, modelId: brain.modelId };
  } catch (error) {
    return rejectedResolution(error);
  }
}

/** Enumerate only held relationships; re-evaluate each route through the call resolver, without caching authority. */
export async function listInferenceRoutes(context: DiscoveryContext, options?: { model?: string }): Promise<InferenceRoute[]> {
  const candidates = await loadInferenceRouteCandidates(context);
  const routes: InferenceRoute[] = [];
  // Sequential: the existing resolver uses custody locks and provider-priority ordering.
  for (const candidate of candidates) {
    const providers = candidate.orgHeld ? ['anthropic'] as const : listBrainConnectors();
    for (const provider of providers) {
      const card = await readInferenceCard(candidate.principal.did, provider, candidate.orgHeld);
      const resolution = await resolveCard(candidate, provider, options?.model);
      routes.push(describeInferenceRoute(candidate, card, resolution));
    }
  }
  return routes;
}
