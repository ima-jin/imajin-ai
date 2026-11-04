import { listUsableModels } from './brain';
import { listInferenceRoutes } from './route-discovery';
import { readInferencePrincipal } from './route-discovery-store';
import { discoveryInferenceRoutes, discoveryModels } from './self-discovery';
import { listDiscoveryConnectorMetadata } from './self-discovery-connectors';
import { inferenceBrainContext } from './route-context';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
import type { InferenceAuthContext } from './auth';

/** One projection for self and the principal's operator view; never returns credentials. */
export async function readSelfDiscoveryCard(context: InferenceAuthContext, principalDid?: string) {
  const actorDid = context.caller?.actorDid ?? context.orgContext?.memberDid ?? context.ownerDid;
  const identity = await readInferencePrincipal(actorDid);
  if (!identity || (principalDid && identity.subtype !== 'agent')) return null;
  const models = await listUsableModels(inferenceBrainContext(context)).catch(error => {
    if (error instanceof ExternalMcpError && error.status === 403) return [];
    if (principalDid && error instanceof ExternalMcpError && error.code === 'credential_unavailable') return [];
    throw error;
  });
  const model = models.at(0)?.modelId;
  const routes = await listInferenceRoutes(context, model ? { model } : undefined);
  const metadata = principalDid ? [] : await listDiscoveryConnectorMetadata(actorDid);
  // An operator sees only their own relationship, not the agent's other clients.
  const visibleRoutes = principalDid ? routes.filter(route => route.billedPrincipal.did === principalDid
    && route.selectors.actingFor === context.caller?.actingFor) : routes;
  const visibleModels = principalDid ? models.filter(row => row.credentialDid === principalDid) : models;
  return {
    identity: {
      did: identity.did, handle: identity.handle, kind: identity.subtype ?? identity.scope,
      tier: identity.tier, actAs: context.caller?.actingAs ?? context.orgContext?.orgDid ?? null,
    },
    usableModels: discoveryModels(visibleModels),
    connectors: [
      ...discoveryInferenceRoutes(visibleRoutes, visibleModels, context),
      // The principal does not own the agent's private connector installations.
      ...(!principalDid ? metadata : []),
    ],
  };
}

export type SelfDiscoveryCard = NonNullable<Awaited<ReturnType<typeof readSelfDiscoveryCard>>>;
export type SelfDiscoveryConnector = SelfDiscoveryCard['connectors'][number];
