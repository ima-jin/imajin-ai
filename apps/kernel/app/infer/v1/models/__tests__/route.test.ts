import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveInferenceAuth, mockRateLimit, mockResolveBrain, mockForwardAnthropicModelsList } = vi.hoisted(() => ({
  mockResolveInferenceAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockResolveBrain: vi.fn(),
  mockForwardAnthropicModelsList: vi.fn(),
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

vi.mock('@/src/lib/inference/brain', async () => {
  const { createFakeBrainErrorClasses } = await import('@/src/lib/inference/__tests__/brain-errors-test-support');
  return { resolveBrain: mockResolveBrain, ...createFakeBrainErrorClasses() };
});

vi.mock('@/src/lib/inference/spend-cap', async () => {
  const { createFakeSpendCapClasses } = await import('@/src/lib/inference/__tests__/brain-errors-test-support');
  return createFakeSpendCapClasses();
});

// `forward.ts` imports `usage-ledger.ts`, which imports the real `@/src/db`
// drizzle client. Mocked here so `vi.importActual` below can load the rest of
// `forward.ts` without a live DATABASE_URL.
vi.mock('@/src/lib/inference/usage-ledger', () => ({
  recordInferenceUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/lib/inference/anthropic-messages/forward', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/inference/anthropic-messages/forward')>(
    '@/src/lib/inference/anthropic-messages/forward',
  );
  return { ...actual, forwardAnthropicModelsList: mockForwardAnthropicModelsList };
});

import { GET, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:supplier';
const APP_DID = 'did:imajin:nanoclaw-app';

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(url = 'https://kernel.test/infer/v1/models'): RouteRequest {
  return { headers: new Headers(), url } as unknown as RouteRequest;
}

const ANTHROPIC_BRAIN = {
  connector: 'anthropic',
  credentialDid: OWNER_DID,
  provider: 'anthropic' as const,
  modelId: 'claude-opus-4-6',
  apiKey: 'sk-ant-sealed-secret',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ limited: false });
  mockResolveInferenceAuth.mockResolvedValue({ ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID } });
  mockResolveBrain.mockResolvedValue(ANTHROPIC_BRAIN);
  mockForwardAnthropicModelsList.mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
});

describe('GET /infer/v1/models', () => {
  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });

  it('returns 401 without a valid bearer or x-api-key', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: false, error: 'Invalid app token', status: 401 });

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
  });

  it('resolves the brain restricted to the anthropic connector and forwards the query string', async () => {
    const res = await GET(makeReq('https://kernel.test/infer/v1/models?after_id=model_1'));

    expect(mockResolveBrain).toHaveBeenCalledWith({ ownerDid: OWNER_DID, appDid: APP_DID }, { connectors: ['anthropic'] });
    expect(mockForwardAnthropicModelsList).toHaveBeenCalledWith(ANTHROPIC_BRAIN, '?after_id=model_1');
    expect(res.status).toBe(200);
  });
});
