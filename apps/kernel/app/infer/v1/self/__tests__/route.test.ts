import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  auth: vi.fn(), identity: vi.fn(), models: vi.fn(), routes: vi.fn(), metadata: vi.fn(), limit: vi.fn(),
}));
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
    expect(h.metadata).toHaveBeenCalledWith(actor);
    expect(h.auth).toHaveBeenCalledWith(expect.anything(), 'infer:completions');
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
});
