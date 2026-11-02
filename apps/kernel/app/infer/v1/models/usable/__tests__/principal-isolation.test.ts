import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { credentials, registrant, appAuth, sessionAuth, orgBrain, picker } = vi.hoisted(() => ({
  credentials: new Map<string, { apiKey: string; modelId?: string }>(),
  registrant: vi.fn(),
  appAuth: vi.fn(),
  sessionAuth: vi.fn(),
  orgBrain: vi.fn(),
  picker: vi.fn(),
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
vi.mock('@/src/lib/inference/org-held-brain', () => ({ resolveOrgHeldBrain: orgBrain }));
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
  listModels: picker,
}));
vi.mock('@/src/lib/gemini/model-handlers', () => ({ listModels: vi.fn() }));
vi.mock('@/src/lib/local/model-handlers', () => ({ listModels: vi.fn() }));
vi.mock('@/src/lib/kernel/openai-compatible-model-picker', () => ({
  createOpenAiCompatibleModelHandlers: vi.fn(),
}));
vi.mock('@/src/lib/openrouter/model-handlers', () => ({ createOpenrouterModelHandlers: vi.fn() }));

import { GET } from '../route';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
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
  picker.mockResolvedValue({ ok: true, models: [] });
  orgBrain.mockResolvedValue({
    connector: 'anthropic', provider: 'anthropic', credentialDid: ORG, modelId: '', apiKey: 'fixture-org-held',
    orgUsage: { memberDid: MAIN, orgDid: ORG, grantId: 'fixture-grant', connectionId: 'fixture-connection' },
  });
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

  it('uses only the personal session context when no acting org is selected', async () => {
    appAuth.mockResolvedValue({ error: 'Not an app token', status: 401 });
    sessionAuth.mockResolvedValue({ identity: { id: MAIN } });
    const response = await GET(request(MAIN));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((row: { id: string }) => row.id)).toEqual(['main-model']);
    expect(orgBrain).not.toHaveBeenCalled();
  });

  it('lists the granted org catalog for a verified acting-org session without personal/app fallback', async () => {
    appAuth.mockResolvedValue({ error: 'Not an app token', status: 401 });
    sessionAuth.mockResolvedValue({ identity: { id: MAIN, actingAs: ORG } });
    picker.mockResolvedValue({ ok: true, models: [{ id: 'org-model' }] });
    const response = await GET(request(MAIN));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((row: { id: string }) => row.id)).toEqual(['org-model']);
    expect(body.data[0].imajin.credentialDid).toBe(ORG);
    expect(orgBrain).toHaveBeenCalledWith({ memberDid: MAIN, orgDid: ORG }, undefined);
    expect(registrant).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('fixture-org-held');
    expect(await listThroughPassthrough(MAIN)).toEqual({ status: 200, body });
  });

  it('returns a grant-naming 403 for an ungranted acting-org session, never a personal catalog or a 500', async () => {
    appAuth.mockResolvedValue({ error: 'Not an app token', status: 401 });
    sessionAuth.mockResolvedValue({ identity: { id: MAIN, actingAs: ORG } });
    const error = 'Active org-connection member grant required for anthropic';
    orgBrain.mockRejectedValue(new ExternalMcpError(403, error));
    const response = await GET(request(MAIN));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error });
    expect(picker).not.toHaveBeenCalled();
    expect(registrant).not.toHaveBeenCalled();
    expect(await listThroughPassthrough(MAIN)).toEqual({ status: 403, body: { error } });
  });

  it.each([MAIN, AGENT, ORG])('missing own connector for %s yields an empty catalog, not a 502 or another principal’s connector', async (principal) => {
    credentials.delete(principal);
    const direct = await GET(request(principal));
    expect(direct.status).toBe(200);
    expect((await direct.json()).data).toEqual([]);
    const proxy = await listThroughPassthrough(principal);
    expect(proxy.status).toBe(200);
    expect(proxy.body.data).toEqual([]);
  });
  it('a sealed agent connector with no selected model does not 502 or affect main', async () => {
    credentials.set(AGENT, { apiKey: 'fixture-agent' });
    const direct = await GET(request(AGENT));
    expect(direct.status).toBe(200);
    expect((await direct.json()).data).toEqual([]);
    const proxy = await listThroughPassthrough(AGENT);
    expect(proxy.status).toBe(200);
    expect(proxy.body.data).toEqual([]);
    const main = await listThroughPassthrough(MAIN);
    expect(main.status).toBe(200);
    expect(main.body.data.map((row: { id: string }) => row.id)).toEqual(['main-model']);
  });
});
