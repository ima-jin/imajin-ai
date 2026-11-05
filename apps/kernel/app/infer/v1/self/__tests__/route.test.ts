import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  auth: vi.fn(), identity: vi.fn(), models: vi.fn(), routes: vi.fn(), metadata: vi.fn(), limit: vi.fn(),
  principal: vi.fn(), serving: vi.fn(), grants: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ resolveActingDid: (identity: { id: string; actingAs?: string }) => identity.actingAs ?? identity.id }));
vi.mock('@/src/lib/auth/grant-principal', () => ({ requireGrantPrincipal: h.principal }));
vi.mock('@/src/lib/auth/agent-service', () => ({ listServingAgents: h.serving }));
vi.mock('@/src/lib/auth/grants', () => ({ listGrantDetailsForDelegator: h.grants }));
vi.mock('@/src/lib/inference/auth', () => ({ resolveInferenceAuth: h.auth }));
vi.mock('@/src/lib/inference/brain', () => ({ listUsableModels: h.models }));
vi.mock('@/src/lib/inference/route-discovery', () => ({ listInferenceRoutes: h.routes }));
vi.mock('@/src/lib/inference/route-discovery-store', () => ({ readInferencePrincipal: h.identity }));
vi.mock('@/src/lib/inference/self-discovery-connectors', () => ({ listDiscoveryConnectorMetadata: h.metadata }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://agent.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@imajin/config', () => ({ rateLimit: h.limit, getClientIP: () => '127.0.0.1' }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
import { GET, OPTIONS } from '../route';
import { GET as usable } from '../../models/usable/route';

const actor = 'did:imajin:agent';
const org = 'did:imajin:artifact';
const request = () => new NextRequest('https://kernel.test/infer/v1/self');
beforeEach(() => {
  vi.resetAllMocks();
  h.limit.mockReturnValue({ limited: false });
  h.auth.mockResolvedValue({ ok: true, context: { ownerDid: actor, caller: { actorDid: actor } } });
  h.identity.mockResolvedValue({ did: actor, handle: 'artifact-jin', scope: 'actor', subtype: 'agent', tier: 'established' });
  h.models.mockResolvedValue([]);
  h.routes.mockResolvedValue([]);
  h.metadata.mockResolvedValue([]);
  h.principal.mockResolvedValue({ identity: { id: 'did:imajin:ryan', actingAs: org } });
  h.serving.mockResolvedValue([{ did: actor, name: 'Artifact-Jin' }]);
  h.grants.mockResolvedValue([]);
});

describe('GET /infer/v1/self', () => {
  it('supports preflight and applies rate limiting before auth', async () => {
    expect((await OPTIONS(request())).status).toBe(204);
    h.limit.mockReturnValue({ limited: true, retryAfter: 4 });
    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('4');
    expect(h.auth).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'Invalid app token'], [403, 'insufficient scope'], [403, 'Not authorized to act as this group'],
  ])('preserves usable-model auth rejection (%s, %s), with no partial discovery', async (status, error) => {
    h.auth.mockResolvedValue({ ok: false, status, error });
    const self = await GET(request());
    const models = await usable(new NextRequest('https://kernel.test/infer/v1/models/usable'));
    expect(self.status).toBe(models.status);
    expect(await self.json()).toEqual(await models.json());
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.models).not.toHaveBeenCalled();
    expect(h.routes).not.toHaveBeenCalled();
    expect(h.metadata).not.toHaveBeenCalled();
  });
  it.each([false, true])('preserves actor identity and model-list parity (acting as org: %s)', async actingAsOrg => {
    const context = { ownerDid: actingAsOrg ? org : actor, caller: { actorDid: actor, ...(actingAsOrg ? { actingAs: org } : {}) } };
    h.auth.mockResolvedValue({ ok: true, context });
    const privateValue = randomUUID();
    h.models.mockResolvedValue([{
      connector: 'anthropic', credentialDid: context.ownerDid, provider: 'anthropic',
      modelId: 'model-one', apiKey: privateValue, picked: true,
    }]);
    h.routes.mockResolvedValue([{
      kind: actingAsOrg ? 'A' : 'own', billedPrincipal: { did: context.ownerDid, handle: actingAsOrg ? 'artifact' : 'artifact-jin' },
      card: { provider: 'anthropic', id: 'card', label: 'Anthropic', loaded: true },
      selectedModels: ['model-one'], usable: true, selectors: actingAsOrg ? { actingAs: org } : {},
    }]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('x-acting-as');
    expect(await response.clone().text()).not.toContain(privateValue);
    const body = await response.json();
    const models = await (await usable(new NextRequest('https://kernel.test/infer/v1/models/usable'))).json();
    expect(body.usableModels.map((model: { id: string }) => model.id)).toEqual(models.data.map((model: { id: string }) => model.id));
    expect(body.identity).toEqual({ did: actor, handle: 'artifact-jin', kind: 'agent', tier: 'established', actAs: actingAsOrg ? org : null });
    expect(body.connectors[0]).toMatchObject({ authority: actingAsOrg ? 'org-held' : 'own-key', usableModels: ['model-one'] });
    expect(h.identity).toHaveBeenCalledWith(actor);
    expect(h.metadata).toHaveBeenCalledWith(context);
    expect(h.auth).toHaveBeenCalledWith(expect.anything(), 'infer:completions', true);
    expect(h.routes).toHaveBeenCalledWith(context, { model: 'model-one' });
    expect(h.models).toHaveBeenCalledWith(context);
  });
  it('keeps a revoked route visible with the existing fixing control and no usable models', async () => {
    h.models.mockRejectedValue(new ExternalMcpError(403, 'Private diagnostic', 'org_grant_required'));
    h.routes.mockResolvedValue([{
      kind: 'C', billedPrincipal: { did: org, handle: 'artifact' },
      card: { provider: 'anthropic', id: 'card', label: 'Anthropic', loaded: false },
      selectedModels: [], usable: false, selectors: { actingAs: org },
      reason: { code: 'no_grant', message: 'No grant' },
    }]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ usableModels: [], connectors: [{
      usable: false, grantStatus: 'denied', reason: { code: 'no_grant' },
      fix: { href: '/auth/connectors#org-connector-anthropic-grants', control: expect.stringContaining('Member grants') },
    }] });
  });
  it('does not invent an identity for a missing/suspended signer', async () => {
    h.identity.mockResolvedValue(undefined);
    expect((await GET(request())).status).toBe(404);
    expect(h.routes).not.toHaveBeenCalled();
  });
  it.each(['identity', 'models', 'routes', 'metadata'] as const)('hides exception details when %s fails', async source => {
    h[source].mockRejectedValue(new Error(randomUUID()));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'self_discovery_unavailable' });
  });
  it('does not downgrade a non-403 custody failure into an empty catalog', async () => {
    h.models.mockRejectedValue(new ExternalMcpError(500, randomUUID()));
    expect((await GET(request())).status).toBe(503);
  });
  it('uses owner-only context for legacy personal sessions', async () => {
    h.auth.mockResolvedValue({ ok: true, context: { ownerDid: actor } });
    h.identity.mockResolvedValue({ did: actor, handle: 'ryan', scope: 'actor', subtype: null, tier: 'soft' });
    const body = await (await GET(request())).json();
    expect(body.identity).toEqual({ did: actor, handle: 'ryan', kind: 'actor', tier: 'soft', actAs: null });
    expect(h.models).toHaveBeenCalledWith(actor);
  });
  it.each([false, true])('lists only the acting principal agents (org: %s)', async actingAsOrg => {
    const principalDid = actingAsOrg ? org : 'did:imajin:ryan';
    h.principal.mockResolvedValue({ identity: { id: 'did:imajin:ryan', ...(actingAsOrg ? { actingAs: org } : {}) } });
    const selectors = actingAsOrg ? { actingAs: org } : { actingFor: principalDid };
    const route = {
      kind: actingAsOrg ? 'A' : 'B', billedPrincipal: { did: principalDid, handle: 'principal' },
      card: { provider: 'anthropic', id: 'held', label: 'Anthropic', loaded: false },
      selectedModels: [], usable: false, selectors,
      reason: { code: 'key_not_loaded', message: 'Key unavailable' },
    };
    h.routes.mockResolvedValue([
      route,
      { ...route, billedPrincipal: { did: 'did:imajin:other-client', handle: 'private' } },
      { ...route, selectors: { ...selectors, actingFor: 'did:imajin:other-human' } },
    ]);
    h.grants.mockResolvedValue([{ agentDid: actor }, { agentDid: 'did:imajin:grant-only' }]);
    h.identity.mockImplementation(async did => ({ did, handle: 'artifact-jin', scope: 'actor', subtype: 'agent', tier: 'established' }));
    const response = await GET(new NextRequest('https://kernel.test/infer/v1/self?agents=1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.principalDid).toBe(principalDid);
    expect(body.cards).toHaveLength(2);
    expect(body.cards[0]).toMatchObject({
      name: 'Artifact-Jin', identity: { did: actor, actAs: actingAsOrg ? org : null },
      connectors: [{ authority: actingAsOrg ? 'org-held' : 'delegated', usable: false,
        fix: { actingDid: principalDid, href: actingAsOrg
          ? `/jin/vault/renew?orgDid=${encodeURIComponent(org)}&provider=anthropic`
          : '/auth/connectors/anthropic' } }],
    });
    expect(body.cards[0].connectors).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('other-client');
    expect(JSON.stringify(body)).not.toContain('other-human');
    expect(h.serving).toHaveBeenCalledWith(principalDid);
    expect(h.grants).toHaveBeenCalledWith(principalDid);
    expect(h.metadata).toHaveBeenCalled();
    expect(h.auth).not.toHaveBeenCalled();
  });
  it.each([false, true])('operator tool rows reveal only the selected principal (org: %s)', async actingAsOrg => {
    const principalDid = actingAsOrg ? org : 'did:imajin:ryan';
    h.principal.mockResolvedValue({
      identity: { id: 'did:imajin:ryan', ...(actingAsOrg ? { actingAs: org } : {}) },
    });
    h.metadata.mockResolvedValue([{
      provider: 'warp', family: 'http', ownerDid: principalDid, authority: actingAsOrg ? 'org-held' : 'delegated',
      configured: true, usable: true, grantStatus: 'granted', usableModels: [],
    }, {
      provider: 'github', family: 'http', ownerDid: actor, configured: true,
    }, {
      provider: 'private-other-provider', family: 'http', ownerDid: 'did:imajin:other-client', configured: true,
    }]);
    const response = await GET(new NextRequest('https://kernel.test/infer/v1/self?agents=1'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cards[0].connectors).toHaveLength(1);
    expect(body.cards[0].connectors[0]).toMatchObject({ provider: 'warp', ownerDid: principalDid, usable: true });
    expect(JSON.stringify(body)).not.toContain('private-other-provider');
    expect(JSON.stringify(body)).not.toContain('github');
  });
  it('retains red operator rows on a known unavailable credential without changing self failure semantics', async () => {
    h.models.mockRejectedValue(new ExternalMcpError(503, 'Private custody detail', 'credential_unavailable'));
    h.routes.mockResolvedValue([{
      kind: 'A', billedPrincipal: { did: org, handle: 'artifact' },
      card: { provider: 'anthropic', id: 'held', label: 'Anthropic', loaded: false },
      selectedModels: [], usable: false, selectors: { actingAs: org },
      reason: { code: 'key_not_loaded', message: 'Organization key unavailable' },
    }]);
    const response = await GET(new NextRequest('https://kernel.test/infer/v1/self?agents=1'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cards[0]).toMatchObject({ usableModels: [], connectors: [{ usable: false }] });
    expect(JSON.stringify(body)).not.toContain('Private custody detail');
    expect((await GET(request())).status).toBe(503);
  });
  it.each([401, 403])('denies operator metadata before enumerating agents (%s)', async status => {
    h.principal.mockResolvedValue({ error: 'Principal required', status });
    const response = await GET(new NextRequest('https://kernel.test/infer/v1/self?agents=1'));
    expect(response.status).toBe(status);
    expect(h.serving).not.toHaveBeenCalled();
    expect(h.grants).not.toHaveBeenCalled();
    expect(h.routes).not.toHaveBeenCalled();
  });
  it.each(['0', '', 'true'])('rejects invalid operator selector %j', async value => {
    expect((await GET(new NextRequest(`https://kernel.test/infer/v1/self?agents=${value}`))).status).toBe(400);
    expect(h.principal).not.toHaveBeenCalled();
  });
  it('omits suspended and non-agent grant subjects, retaining an empty principal view', async () => {
    h.serving.mockResolvedValue([]);
    h.grants.mockResolvedValue([{ agentDid: 'suspended' }, { agentDid: 'human' }]);
    h.identity.mockImplementation(async did => did === 'suspended' ? null : { did, scope: 'actor', subtype: 'human', tier: 'soft' });
    const response = await GET(new NextRequest('https://kernel.test/infer/v1/self?agents=1'));
    expect(await response.json()).toEqual({ principalDid: org, cards: [] });
  });
  it.each(['serving', 'grants'] as const)('fails closed when operator %s storage fails', async source => {
    h[source].mockRejectedValue(new Error('private details'));
    const response = await GET(new NextRequest('https://kernel.test/infer/v1/self?agents=1'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'self_discovery_unavailable' });
  });
});
