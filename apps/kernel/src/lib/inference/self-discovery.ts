import type { InferenceAuthContext } from './auth';
import type { InferenceRoute, InferenceRouteKind, InferenceRouteReason } from './route-discovery';
import type { UsableModel } from './model-catalog';

export type ConnectorFamily = 'openai-compatible' | 'anthropic' | 'mcp' | 'http';
export type ConnectorAuthority = 'own-key' | 'org-held' | 'delegated' | 'member-grant';

const AUTHORITIES: Record<InferenceRouteKind, ConnectorAuthority> = {
  own: 'own-key', A: 'org-held', B: 'delegated', C: 'member-grant',
};

/** Route kinds already encode authority; never infer it from custody/registry rows. */
export function inferenceAuthority(kind: InferenceRouteKind): ConnectorAuthority {
  return AUTHORITIES[kind];
}
function grantStatus(route: InferenceRoute) {
  if (route.reason?.code === 'no_grant') return 'denied';
  if (!route.usable) return 'not-evaluated';
  return route.kind === 'C' ? 'granted' : 'not-required';
}

export function discoveryFix(route: InferenceRoute) {
  const provider = encodeURIComponent(route.card.provider);
  const orgControl = `/auth/connectors#org-connector-${provider}-grants`;
  const fixes: Record<InferenceRouteReason, { control: string; href: string }> = {
    no_grant: { control: 'Org service keys → Member grants → Grant', href: orgControl },
    not_a_member: { control: 'Members', href: '/auth/members' },
    not_authorized: { control: 'Agents → assignment and allowed services', href: '/auth/agents' },
    key_not_loaded: route.kind === 'A' || route.kind === 'C'
      ? { control: 'Renew org-held key', href: `/jin/vault/renew?orgDid=${encodeURIComponent(route.billedPrincipal.did)}&provider=${provider}` }
      : { control: 'Connector → credential and scope grants', href: `/auth/connectors/${provider}` },
    no_model_selected: { control: 'Connector → model picker', href: `/auth/connectors/${provider}` },
    route_unavailable: { control: 'Connectors → Inference routes', href: '/auth/connectors' },
  };
  return {
    ...fixes[route.reason?.code ?? 'route_unavailable'],
    actingDid: route.billedPrincipal.did,
  };
}

/** Picker results contain credentials internally. Project each public field explicitly. */
export function discoveryModels(models: readonly UsableModel[]) {
  return models.map(model => ({
    id: model.modelId, connector: model.connector, credentialDid: model.credentialDid, picked: model.picked,
  }));
}

export function discoveryInferenceRoutes(routes: readonly InferenceRoute[], models: readonly UsableModel[], context: InferenceAuthContext) {
  return routes.map(route => {
    const selected = route.selectors.actingAs === context.caller?.actingAs
      && route.selectors.actingFor === context.caller?.actingFor;
    return {
      provider: route.card.provider,
      family: route.card.provider === 'anthropic' ? 'anthropic' as const : 'openai-compatible' as const,
      authority: inferenceAuthority(route.kind),
      kind: route.kind,
      billedPrincipal: { did: route.billedPrincipal.did, handle: route.billedPrincipal.handle },
      card: { id: route.card.id, label: route.card.label },
      configured: route.card.loaded,
      grantStatus: grantStatus(route),
      selectedModels: [...route.selectedModels],
      usableModels: selected && route.usable
        ? models.filter(model => model.connector === route.card.provider && model.credentialDid === route.billedPrincipal.did)
          .map(model => model.modelId)
        : [],
      usable: route.usable,
      selectors: {
        ...(route.selectors.actingAs ? { actingAs: route.selectors.actingAs } : {}),
        ...(route.selectors.actingFor ? { actingFor: route.selectors.actingFor } : {}),
      },
      ...(route.reason ? { reason: { code: route.reason.code, message: route.reason.message } } : {}),
      ...(!route.usable ? { fix: discoveryFix(route) } : {}),
    };
  });
}
