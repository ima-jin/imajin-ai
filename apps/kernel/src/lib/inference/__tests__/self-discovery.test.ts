import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { discoveryFix, discoveryInferenceRoutes, discoveryModels, inferenceAuthority } from '../self-discovery';
import type { InferenceRoute, InferenceRouteKind } from '../route-discovery';
import type { UsableModel } from '../model-catalog';

const actor = 'did:imajin:agent';
const org = 'did:imajin:org';
const route: InferenceRoute = {
  kind: 'A', billedPrincipal: { did: org, handle: 'artifact' },
  card: { provider: 'anthropic', id: 'card', label: 'Anthropic', loaded: true },
  selectedModels: ['model-one'], usable: true, selectors: { actingAs: org },
};

describe('self-discovery allowlisted projections', () => {
  it.each([
    ['own', 'own-key'], ['A', 'org-held'], ['B', 'delegated'], ['C', 'member-grant'],
  ] as const)('maps %s to %s in one pure table', (kind, authority) => {
    expect(inferenceAuthority(kind)).toBe(authority);
  });
  it('exposes models only for matching principal, connector and selectors, without custody fields', () => {
    const privateValue = randomUUID();
    const models: UsableModel[] = [{
      connector: 'anthropic', credentialDid: org, provider: 'anthropic',
      modelId: 'model-one', apiKey: privateValue, picked: true,
    }];
    const injectedRoute = { ...route, vaultReference: privateValue };
    const context = { ownerDid: org, caller: { actorDid: actor, actingAs: org } };
    const rows = discoveryInferenceRoutes([injectedRoute], models, context);
    expect(rows[0]).toMatchObject({ authority: 'org-held', family: 'anthropic', usableModels: ['model-one'] });
    expect(rows[0]).not.toHaveProperty('fix');
    expect(JSON.stringify({ rows, models: discoveryModels(models) })).not.toContain(privateValue);
    for (const variant of [
      { ...route, selectors: { actingAs: org, actingFor: 'did:imajin:speaker' } },
      { ...route, billedPrincipal: { did: actor, handle: null } },
      { ...route, card: { ...route.card, provider: 'openai' as const } },
      { ...route, usable: false },
    ]) {
      expect(discoveryInferenceRoutes([variant], models, context)[0].usableModels).toEqual([]);
    }
  });
  it.each([
    ['no_grant', '/auth/connectors#org-connector-anthropic-grants', 'Member grants'],
    ['not_a_member', '/auth/members', 'Members'],
    ['not_authorized', '/auth/agents', 'assignment'],
    ['key_not_loaded', '/auth/connectors', 'Load key'],
    ['no_model_selected', '/auth/connectors/anthropic', 'model picker'],
    ['route_unavailable', '/auth/connectors', 'Inference routes'],
  ] as const)('names an existing fixing control for %s', (code, href, control) => {
    expect(discoveryFix({ ...route, usable: false, reason: { code, message: 'Denied' } })).toEqual({
      control: expect.stringContaining(control), href, actingDid: org,
    });
  });
  it.each(['own', 'B'] as InferenceRouteKind[])('sends a %s unloaded key to its principal connector', kind => {
    const row = { ...route, kind, usable: false, reason: { code: 'key_not_loaded' as const, message: 'Unavailable' } };
    expect(discoveryInferenceRoutes([row], [], { ownerDid: actor })[0].fix?.href).toBe('/auth/connectors/anthropic');
  });
  it('marks revoked grants denied and never returns usable models for that route', () => {
    const row = { ...route, kind: 'C' as const, usable: false, reason: { code: 'no_grant' as const, message: 'No grant' } };
    expect(discoveryInferenceRoutes([row], [], { ownerDid: org })[0]).toMatchObject({
      authority: 'member-grant', grantStatus: 'denied', usable: false, usableModels: [],
      fix: { control: expect.stringContaining('Member grants') },
    });
  });
});
