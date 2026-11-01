import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { credentials, registrant, appAuth, sessionAuth } = vi.hoisted(() => ({
  credentials: new Map<string, { apiKey: string; modelId: string }>(),
  registrant: vi.fn(),
  appAuth: vi.fn(),
  sessionAuth: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: appAuth,
  requireAuth: sessionAuth,
  resolveActingDid: (identity: { id: string; actingAs?: string }) => identity.actingAs ?? identity.id,
}));
vi.mock('@imajin/config', () => ({
  getClientIP: () => '203.0.113.19',
  rateLimit: () => ({ limited: false }),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/kernel/app-registrant', () => ({ lookupAppRegistrantDid: registrant }));
vi.mock('@/src/lib/gemini/connector', () => ({ loadGeminiCredentials: async () => undefined }));
vi.mock('@/src/lib/anthropic/connector', () => ({
  loadAnthropicCredentials: async (did: string) => credentials.get(did),
}));
vi.mock('@/src/lib/xai/connector', () => ({
  loadXaiCredentials: async () => undefined, XAI_BASE_URL: 'https://xai.test',
}));
vi.mock('@/src/lib/openai/connector', () => ({
  loadOpenaiCredentials: async () => undefined, OPENAI_BASE_URL: 'https://openai.test',
}));
vi.mock('@/src/lib/moonshot/connector', () => ({
  loadMoonshotCredentials: async () => undefined, MOONSHOT_BASE_URL: 'https://moonshot.test',
}));
vi.mock('@/src/lib/zai/connector', () => ({
  loadZaiCredentials: async () => undefined, ZAI_BASE_URL: 'https://zai.test',
}));
vi.mock('@/src/lib/local/connector', () => ({ loadLocalCredentials: async () => undefined }));
vi.mock('@/src/lib/openrouter/connector', () => ({
  loadOpenrouterCredentials: async () => undefined, OPENROUTER_BASE_URL: 'https://openrouter.test',
}));
vi.mock('@/src/lib/anthropic/model-handlers', () => ({
  listModels: async () => ({ ok: true, models: [] }),
}));
vi.mock('@/src/lib/gemini/model-handlers', () => ({ listModels: vi.fn() }));
vi.mock('@/src/lib/local/model-handlers', () => ({ listModels: vi.fn() }));
vi.mock('@/src/lib/kernel/openai-compatible-model-picker', () => ({
  createOpenAiCompatibleModelHandlers: vi.fn(),
}));
vi.mock('@/src/lib/openrouter/model-handlers', () => ({ createOpenrouterModelHandlers: vi.fn() }));

import { GET } from '../route';
import { resolveBrain } from '@/src/lib/inference/brain';
import { handleModels } from '../../../../../../../../packages/openclaw-infer-passthrough/src/handle-models';

const MAIN = 'did:imajin:main-fixture';
const AGENT = 'did:imajin:8gqnAWGGms2cyrZ4krfNQjknYWMfJcoHgnxha8AfKwUY';
const ORG = 'did:imajin:artifact-org-fixture';
const APP = 'did:imajin:openclaw-app-fixture';
const KERNEL = 'https://kernel.test/infer/v1/models/usable';

function request(principal: string) {
  return new Request(KERNEL, {
    headers: { authorization: `Bearer ${principal}`, 'x-acting-for': ORG },
  }) as Parameters<typeof GET>[0];
}

async function listThroughPassthrough(principal: string) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe(KERNEL);
    return GET(new Request(url, init) as Parameters<typeof GET>[0]);
  });
  const response = await handleModels({
    routes: [{ id: 'openai', principalDid: principal }],
    kernelBaseUrl: 'https://kernel.test',
    kernelTimeoutMs: 5_000,
    getTokenProvider: () => ({ getToken: async () => principal, invalidate: vi.fn() }),
  });
  return { status: response.status, body: await new Response(response.body).json() };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(1_793_567_000_000);
  credentials.clear();
  // Synthetic, non-authority-bearing fixtures; no live provider key or token.
  credentials.set(MAIN, { apiKey: 'fixture-main', modelId: 'main-model' });
  credentials.set(AGENT, { apiKey: 'fixture-agent', modelId: 'agent-model' });
  registrant.mockResolvedValue(ORG);
  appAuth.mockImplementation(async (req: Request) => ({
    appAuth: { userDid: req.headers.get('authorization')?.slice('Bearer '.length), appDid: APP },
  }));
  sessionAuth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('#3198 principal-scoped sealed inference (real auth orchestration + brain walk)', () => {
  it.each([MAIN, AGENT])('lists only the authenticated principal %s through usable and passthrough', async (principal) => {
    const model = credentials.get(principal)!.modelId;
    const direct = await GET(request(principal));
    expect(direct.status).toBe(200);
    const body = await direct.json();
    expect(body.data.map((row: { id: string }) => row.id)).toEqual([model]);
    expect(body.data[0].imajin.credentialDid).toBe(principal);
    expect(JSON.stringify(body)).not.toContain('apiKey');
    const proxy = await listThroughPassthrough(principal);
    expect(proxy.status).toBe(200);
    expect(proxy.body).toEqual(body);
  });

  it.each([undefined, ORG])('uses the personal or acting-as-org session context: %s', async (actingAs) => {
    appAuth.mockResolvedValue({ error: 'Not an app token', status: 401 });
    sessionAuth.mockResolvedValue({ identity: { id: MAIN, actingAs } });
    const response = await GET(request(MAIN));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((row: { id: string }) => row.id)).toEqual(actingAs ? [] : ['main-model']);
  });

  // Known policy conflict, NOT an implemented isolation fix and NOT a live 502
  // reproduction. #1624 explicitly allows this registrant subsidy; #3198
  // requires agent connectors to remain principal-only. Each assertion below
  // was observed failing normally before preserving it as an expected failure.
  it.each([MAIN, ORG])('usable must not list the agent registrant’s connector for %s', async (principal) => {
    registrant.mockResolvedValue(AGENT);
    const direct = await GET(request(principal));
    expect(direct.status).toBe(200);
    const body = await direct.json();
    expect(body.data.map((row: { id: string }) => row.id)).toEqual(principal === MAIN ? ['main-model'] : []);
  });

  it.each([MAIN, ORG])('passthrough must not list the agent registrant’s connector for %s', async (principal) => {
    registrant.mockResolvedValue(AGENT);
    const proxy = await listThroughPassthrough(principal);
    expect(proxy.status).toBe(200);
    expect(proxy.body.data.map((row: { id: string }) => row.id)).toEqual(principal === MAIN ? ['main-model'] : []);
  });

  it('the org must not resolve its agent registrant’s sealed credential', async () => {
    registrant.mockResolvedValue(AGENT);
    await expect(resolveBrain({ ownerDid: ORG, appDid: APP })).rejects.toMatchObject({
      name: 'NoBrainSealedError',
    });
  });

  it('main must not resolve its agent registrant’s sealed credential by model id', async () => {
    registrant.mockResolvedValue(AGENT);
    const brain = await resolveBrain({ ownerDid: MAIN, appDid: APP }, { model: 'agent-model' });
    expect(brain.credentialDid).toBe(MAIN);
  });
});
