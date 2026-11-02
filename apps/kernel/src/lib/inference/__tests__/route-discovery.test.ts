import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const { resolve, candidates, card } = vi.hoisted(() => ({
  resolve: vi.fn(), candidates: vi.fn(), card: vi.fn(),
}));
vi.mock('../brain', async importOriginal => ({
  ...await importOriginal<typeof import('../brain')>(),
  resolveBrain: resolve, listBrainConnectors: () => ['anthropic'],
}));
vi.mock('../route-discovery-store', () => ({
  loadInferenceRouteCandidates: candidates, readInferenceCard: card,
}));
vi.mock('../model-catalog', () => ({ expandUsableModels: vi.fn(), resolvePickerModel: vi.fn() }));
vi.mock('@/src/lib/kernel/app-registrant', () => ({ lookupAppRegistrantDid: vi.fn() }));
vi.mock('@/src/lib/gemini/connector', () => ({ loadGeminiCredentials: vi.fn() }));
vi.mock('@/src/lib/anthropic/connector', () => ({ loadAnthropicCredentials: vi.fn() }));
vi.mock('@/src/lib/xai/connector', () => ({ loadXaiCredentials: vi.fn(), XAI_BASE_URL: '' }));
vi.mock('@/src/lib/openai/connector', () => ({ loadOpenaiCredentials: vi.fn(), OPENAI_BASE_URL: '' }));
vi.mock('@/src/lib/moonshot/connector', () => ({ loadMoonshotCredentials: vi.fn(), MOONSHOT_BASE_URL: '' }));
vi.mock('@/src/lib/zai/connector', () => ({ loadZaiCredentials: vi.fn(), ZAI_BASE_URL: '' }));
vi.mock('@/src/lib/local/connector', () => ({ loadLocalCredentials: vi.fn() }));
vi.mock('@/src/lib/openrouter/connector', () => ({ loadOpenrouterCredentials: vi.fn(), OPENROUTER_BASE_URL: '' }));
import { describeInferenceRoute, listInferenceRoutes } from '../route-discovery';
import type { InferenceRouteCandidate, InferenceRouteKind } from '../route-discovery';
import { NoBrainSealedError, NoModelSelectedError } from '../brain';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';

const MEMBER = 'did:imajin:member';
const ORG = 'did:imajin:Fp5QtWo9vsmS7G5AcbuEUrPT6oGbKxj5gke6T4voH7xE';
const AGENT = 'did:imajin:8gqnAWGGms2cyrZ4krfNQjknYWMfJcoHgnxha8AfKwUY';
const MODEL = 'claude-sonnet-5-5';

function candidate(kind: InferenceRouteKind = 'own'): InferenceRouteCandidate {
  const did = kind === 'A' || kind === 'C' ? ORG : MEMBER;
  return {
    kind, principal: { did, handle: did === ORG ? 'artifact' : 'ryan' },
    memberDid: MEMBER, selectors: did === ORG ? { actingAs: ORG } : {},
    context: { ownerDid: did }, orgHeld: kind === 'A' || kind === 'C',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  candidates.mockResolvedValue([candidate()]);
  card.mockImplementation(async (_did, provider) => ({ provider, id: 'card-primary', label: 'Inference account' }));
  resolve.mockImplementation(async (context) => ({
    credentialDid: context.ownerDid, connector: 'anthropic', provider: 'anthropic', modelId: MODEL,
    apiKey: randomUUID(),
  }));
});

describe('inference route discovery through the existing resolver', () => {
  it.each(['own', 'A', 'B', 'C'] as const)('projects a usable %s route without any credential fields', async kind => {
    const selected = candidate(kind);
    candidates.mockResolvedValue([selected]);
    const [route] = await listInferenceRoutes({ ownerDid: selected.principal.did });
    expect(resolve).toHaveBeenCalledWith(selected.context, { connectors: ['anthropic'] });
    expect(route).toEqual({
      kind, billedPrincipal: selected.principal,
      card: { provider: 'anthropic', id: 'card-primary', label: 'Inference account', loaded: true },
      selectedModels: [MODEL], usable: true, selectors: selected.selectors,
    });
  });

  it('names Artifact as the billed principal for the Artifact-Jin org-agent route', async () => {
    const selected = candidate('A');
    selected.context = { ownerDid: ORG, appDid: AGENT };
    candidates.mockResolvedValue([selected]);
    const [route] = await listInferenceRoutes({ ownerDid: ORG, appDid: AGENT });
    expect(route).toMatchObject({
      kind: 'A', billedPrincipal: { did: ORG, handle: 'artifact' }, selectedModels: [MODEL], usable: true,
    });
  });

  it.each([
    [new ExternalMcpError(403, 'Active org-connection member grant required for anthropic'), 'no_grant'],
    [new ExternalMcpError(403, 'Not a member of the org'), 'not_a_member'],
    [new ExternalMcpError(403, 'Agent → member chain not supported yet'), 'agent_member_chain_unsupported'],
    [new ExternalMcpError(403, 'Agent is not assigned to this identity or service'), 'not_authorized'],
    [new ExternalMcpError(503, 'Organization inference credential unavailable'), 'key_not_loaded'],
    [new Error('unexpected vault fault'), 'route_unavailable'],
    [new NoBrainSealedError([MEMBER], []), 'key_not_loaded'],
    [new NoModelSelectedError([]), 'no_model_selected'],
  ])('explains resolver rejection %s without forwarding exception text', async (error, code) => {
    resolve.mockRejectedValue(error);
    const [route] = await listInferenceRoutes({ ownerDid: MEMBER });
    expect(route.usable).toBe(false);
    expect(route.reason?.code).toBe(code);
    expect(route.reason?.message).toBeTruthy();
  });

  it('names the member, org and provider in a missing-grant explanation', async () => {
    candidates.mockResolvedValue([candidate('C')]);
    resolve.mockRejectedValue(new ExternalMcpError(403, 'Active org-connection member grant required'));
    const [route] = await listInferenceRoutes({ ownerDid: ORG });
    expect(route.reason?.message).toBe(`No grant for ${MEMBER} on @artifact (${ORG}) anthropic`);
  });

  it('marks an empty-model org resolver result as loaded but unusable, never inventing a default', async () => {
    resolve.mockResolvedValue({ credentialDid: MEMBER, connector: 'anthropic', modelId: '' });
    const [route] = await listInferenceRoutes({ ownerDid: MEMBER });
    expect(route).toMatchObject({ card: { loaded: true }, selectedModels: [], usable: false, reason: { code: 'no_model_selected' } });
  });

  it('does not mistake a different provider or fallback principal for the advertised card', async () => {
    resolve.mockResolvedValue({ credentialDid: 'did:imajin:unrelated', connector: 'anthropic', modelId: MODEL });
    const routes = await listInferenceRoutes({ ownerDid: MEMBER });
    expect(routes[0].reason?.code).toBe('route_unavailable');
    expect(JSON.stringify(routes)).not.toContain('unrelated');
    resolve.mockResolvedValue({ credentialDid: MEMBER, connector: 'openai', modelId: MODEL });
    expect((await listInferenceRoutes({ ownerDid: MEMBER }))[0].usable).toBe(false);
  });

  it('does not read an unselected assignment through the pre-#3182 resolver', async () => {
    candidates.mockResolvedValue([{ ...candidate('A'), pendingAssignmentResolver: true }]);
    expect((await listInferenceRoutes({ ownerDid: MEMBER }))[0].usable).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('never returns keys, fingerprints, vault references, or untrusted error content', async () => {
    const sensitive = randomUUID();
    resolve.mockRejectedValue(new ExternalMcpError(503, sensitive));
    card.mockResolvedValue({ provider: 'anthropic', id: 'card', label: 'Primary', sealedKeyField: sensitive, fingerprint: sensitive });
    const text = JSON.stringify(await listInferenceRoutes({ ownerDid: MEMBER }));
    for (const forbidden of [sensitive, 'sealedKeyField', 'fingerprint', 'apiKey']) expect(text).not.toContain(forbidden);
  });

  it('returns no routes when the store finds no held identity', async () => {
    candidates.mockResolvedValue([]);
    expect(await listInferenceRoutes({ ownerDid: MEMBER })).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('pure credential-free route projection', () => {
  it('allows no-model and unloaded diagnostics independently of authorization', () => {
    const selected = candidate();
    const metadata = { provider: 'anthropic' as const, id: 'card', label: 'Primary' };
    expect(describeInferenceRoute(selected, metadata, { loaded: false }).reason?.code).toBe('key_not_loaded');
    expect(describeInferenceRoute(selected, metadata, { loaded: true }).reason?.code).toBe('no_model_selected');
    expect(describeInferenceRoute(selected, metadata, { loaded: true, modelId: MODEL, denied: 'no_grant' }).usable).toBe(false);
  });
});
