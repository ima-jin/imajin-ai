import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockResolveInferenceAuth, mockRateLimit, mockListUsableBrains } = vi.hoisted(() => ({
  mockResolveInferenceAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockListUsableBrains: vi.fn(),
}));

vi.mock('@/src/lib/inference/auth', () => ({
  resolveInferenceAuth: mockResolveInferenceAuth,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://agent.example' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: mockRateLimit,
  getClientIP: () => '203.0.113.7',
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/inference/brain', () => ({
  listUsableBrains: mockListUsableBrains,
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { GET, OPTIONS } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:supplier';
const APP_DID = 'did:imajin:openclaw-app';

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(headers: Record<string, string> = {}): RouteRequest {
  return { headers: new Headers(headers) } as unknown as RouteRequest;
}

const XAI_BRAIN = {
  connector: 'xai',
  credentialDid: OWNER_DID,
  provider: 'openai' as const,
  modelId: 'grok-4',
  apiKey: 'xai-secret',
  baseURL: 'https://api.x.ai/v1',
};

const OPENAI_BRAIN = {
  connector: 'openai',
  credentialDid: OWNER_DID,
  provider: 'openai' as const,
  modelId: 'gpt-6-astra',
  apiKey: 'openai-secret',
  baseURL: 'https://api.openai.com/v1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ limited: false });
  mockResolveInferenceAuth.mockResolvedValue({ ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID } });
  mockListUsableBrains.mockResolvedValue([]);
});

describe('GET /infer/v1/models/usable — request gating', () => {
  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });

  it('returns 429 when rate limited, before auth is even checked', async () => {
    mockRateLimit.mockReturnValueOnce({ limited: true, retryAfter: 12 });

    const res = await GET(makeReq());

    expect(res.status).toBe(429);
    expect(mockResolveInferenceAuth).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: false, error: 'Invalid app token', status: 401 });

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid app token' });
  });

  it('returns 403 on a wrong-scope grant', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: false, error: 'insufficient scope', status: 403 });

    const res = await GET(makeReq());

    expect(res.status).toBe(403);
  });

  it('requests auth with the infer:completions scope, distinct from infer:provide', async () => {
    await GET(makeReq());
    expect(mockResolveInferenceAuth).toHaveBeenCalledWith(expect.anything(), 'infer:completions');
  });
});

describe('GET /infer/v1/models/usable — listing', () => {
  it('lists usable brains in resolution order using the OpenAI list shape', async () => {
    mockListUsableBrains.mockResolvedValueOnce([XAI_BRAIN, OPENAI_BRAIN]);

    const res = await GET(makeReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      id: 'grok-4',
      object: 'model',
      owned_by: 'xai',
      imajin: { connector: 'xai', credentialDid: OWNER_DID, servable: true },
    });
    expect(body.data[1]).toMatchObject({ id: 'gpt-6-astra', owned_by: 'openai' });
  });

  it('never includes a raw apiKey anywhere in the response', async () => {
    mockListUsableBrains.mockResolvedValueOnce([XAI_BRAIN]);

    const res = await GET(makeReq());
    const text = JSON.stringify(await res.json());

    expect(text).not.toContain('xai-secret');
  });

  it('returns 200 with an empty data array when nothing is sealed, not 422', async () => {
    mockListUsableBrains.mockResolvedValueOnce([]);

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ object: 'list', data: [] }));
  });

  it('resolves onBehalfOf the principal when an appDid is present', async () => {
    await GET(makeReq());
    expect(mockListUsableBrains).toHaveBeenCalledWith({ ownerDid: OWNER_DID, appDid: APP_DID });
  });

  it('resolves by ownerDid alone when calling on ones own behalf', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: true, context: { ownerDid: OWNER_DID } });

    await GET(makeReq());

    expect(mockListUsableBrains).toHaveBeenCalledWith(OWNER_DID);
  });

  it('returns 500 when listing fails unexpectedly', async () => {
    mockListUsableBrains.mockRejectedValueOnce(new Error('vault offline'));

    const res = await GET(makeReq());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'models_list_failed' }));
  });
});
