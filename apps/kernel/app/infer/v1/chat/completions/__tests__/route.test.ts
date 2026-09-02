import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockResolveInferenceAuth,
  mockRateLimit,
  mockResolveBrain,
  mockForwardAnthropic,
  mockForwardOpenAiCompatible,
  mockReadConnectorRegistration,
  mockEnforceSpendCap,
} = vi.hoisted(() => ({
  mockResolveInferenceAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockResolveBrain: vi.fn(),
  mockForwardAnthropic: vi.fn(),
  mockForwardOpenAiCompatible: vi.fn(),
  mockReadConnectorRegistration: vi.fn(),
  mockEnforceSpendCap: vi.fn(),
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

// `brain.ts` pulls in a real drizzle client + connector modules purely to
// build error messages. The route only needs `resolveBrain` plus the error
// TYPES for `instanceof` matching — see `brain-errors-test-support.ts` for
// the shared shape used by every route/adapter test that mocks this module.
vi.mock('@/src/lib/inference/brain', async () => {
  const { createFakeBrainErrorClasses } = await import('@/src/lib/inference/__tests__/brain-errors-test-support');
  return { resolveBrain: mockResolveBrain, ...createFakeBrainErrorClasses() };
});

vi.mock('@/src/lib/inference/completions/anthropic-adapter', () => ({
  forwardAnthropic: mockForwardAnthropic,
}));

vi.mock('@/src/lib/inference/completions/openai-compatible-adapter', () => ({
  forwardOpenAiCompatible: mockForwardOpenAiCompatible,
}));

vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  connectorRegistryId: (ownerDid: string, provider: string) => `conn_${ownerDid}_${provider}`,
  readConnectorRegistration: mockReadConnectorRegistration,
}));

// Fully replaced (no `importActual`) — the real module imports `@/src/db`,
// which throws at import time without a live DATABASE_URL. Reuses the same
// fake `SpendCapExceededError` shape `brain-http-errors.test.ts` mocks with,
// declared once in `brain-errors-test-support.ts`.
vi.mock('@/src/lib/inference/spend-cap', async () => {
  const { createFakeSpendCapClasses } = await import('@/src/lib/inference/__tests__/brain-errors-test-support');
  return { ...createFakeSpendCapClasses(), enforceSpendCap: mockEnforceSpendCap };
});

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST, OPTIONS } from '../route';
import { NoBrainSealedError, NoModelSelectedError, ModelDeprecatedError } from '@/src/lib/inference/brain';
import { UpstreamTimeoutError, UpstreamUnavailableError } from '@/src/lib/inference/completions/errors';
import { SpendCapExceededError } from '@/src/lib/inference/spend-cap';
import { VaultDelegationError } from '@/src/lib/vault/errors';
import { RetryError } from 'ai';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:supplier';
const APP_DID = 'did:imajin:openclaw-app';

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(opts: {
  headers?: Record<string, string>;
  body?: unknown;
  invalidJson?: boolean;
} = {}): RouteRequest {
  return {
    headers: new Headers(opts.headers ?? {}),
    json: async () => {
      if (opts.invalidJson) throw new Error('invalid json');
      return opts.body ?? { messages: [{ role: 'user', content: 'hi' }] };
    },
  } as unknown as RouteRequest;
}

const XAI_BRAIN = {
  connector: 'xai',
  credentialDid: OWNER_DID,
  provider: 'openai' as const,
  modelId: 'grok-4',
  apiKey: 'xai-secret',
  baseURL: 'https://api.x.ai/v1',
};

const ANTHROPIC_BRAIN = {
  connector: 'anthropic',
  credentialDid: OWNER_DID,
  provider: 'anthropic' as const,
  modelId: 'claude-sonnet-4-20250514',
  apiKey: 'anthropic-secret',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ limited: false });
  mockResolveInferenceAuth.mockResolvedValue({ ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID } });
  mockResolveBrain.mockResolvedValue(XAI_BRAIN);
  mockForwardOpenAiCompatible.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  mockForwardAnthropic.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  mockReadConnectorRegistration.mockResolvedValue(undefined);
  mockEnforceSpendCap.mockResolvedValue(undefined);
});

describe('POST /infer/v1/chat/completions — request gating', () => {
  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });

  it('returns 429 when rate limited, before auth is even checked', async () => {
    mockRateLimit.mockReturnValueOnce({ limited: true, retryAfter: 12 });

    const res = await POST(makeReq());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
    expect(mockResolveInferenceAuth).not.toHaveBeenCalled();
  });

  it('propagates an auth failure with its own status and error', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: false, error: 'Invalid app token', status: 401 });

    const res = await POST(makeReq());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid app token' });
  });

  it('requests auth with the infer:completions scope, distinct from infer:provide', async () => {
    await POST(makeReq());
    expect(mockResolveInferenceAuth).toHaveBeenCalledWith(expect.anything(), 'infer:completions');
  });

  it('returns 400 on invalid JSON', async () => {
    const res = await POST(makeReq({ invalidJson: true }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when messages is missing or empty', async () => {
    const res1 = await POST(makeReq({ body: {} }));
    expect(res1.status).toBe(400);

    const res2 = await POST(makeReq({ body: { messages: [] } }));
    expect(res2.status).toBe(400);
  });
});

describe('POST /infer/v1/chat/completions — dispatch', () => {
  it('resolves the brain onBehalfOf the principal when an appDid is present', async () => {
    await POST(makeReq());
    expect(mockResolveBrain).toHaveBeenCalledWith({ ownerDid: OWNER_DID, appDid: APP_DID });
  });

  it('resolves the brain by ownerDid alone when calling on ones own behalf', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: true, context: { ownerDid: OWNER_DID } });
    await POST(makeReq());
    expect(mockResolveBrain).toHaveBeenCalledWith(OWNER_DID);
  });

  it('dispatches OpenAI-compatible connectors (xai/gemini/openai) to forwardOpenAiCompatible', async () => {
    mockResolveBrain.mockResolvedValueOnce(XAI_BRAIN);
    const body = { messages: [{ role: 'user', content: 'hi' }] };

    await POST(makeReq({ body, headers: { 'x-session-id': 'sess_1', 'x-turn-id': 'turn_1' } }));

    expect(mockForwardOpenAiCompatible).toHaveBeenCalledWith(XAI_BRAIN, body, { sessionId: 'sess_1', turnId: 'turn_1', agentDid: APP_DID });
    expect(mockForwardAnthropic).not.toHaveBeenCalled();
  });

  it('dispatches the anthropic connector to forwardAnthropic', async () => {
    mockResolveBrain.mockResolvedValueOnce(ANTHROPIC_BRAIN);
    const body = { messages: [{ role: 'user', content: 'hi' }] };

    await POST(makeReq({ body }));

    expect(mockForwardAnthropic).toHaveBeenCalledWith(ANTHROPIC_BRAIN, body, { sessionId: undefined, turnId: undefined, agentDid: APP_DID });
    expect(mockForwardOpenAiCompatible).not.toHaveBeenCalled();
  });

  it('checks the spend cap on the credential-supplying connector before forwarding', async () => {
    mockReadConnectorRegistration.mockResolvedValueOnce({ id: 'conn_real_row', spendCap: { amountUsd: 10, period: 'daily' } });

    await POST(makeReq());

    expect(mockReadConnectorRegistration).toHaveBeenCalledWith(OWNER_DID, 'xai');
    expect(mockEnforceSpendCap).toHaveBeenCalledWith('conn_real_row', { amountUsd: 10, period: 'daily' });
  });

  it('falls back to a computed connector id when no registration row exists yet', async () => {
    mockReadConnectorRegistration.mockResolvedValueOnce(undefined);

    await POST(makeReq());

    expect(mockEnforceSpendCap).toHaveBeenCalledWith(`conn_${OWNER_DID}_xai`, undefined);
  });

  it('attaches CORS headers to the adapter response without altering its body/status', async () => {
    mockForwardOpenAiCompatible.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'chatcmpl-1' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://agent.example');
    expect(await res.json()).toEqual({ id: 'chatcmpl-1' });
  });
});

describe('POST /infer/v1/chat/completions — pipeline outcomes', () => {
  it('returns 422 no_brain when no DID has sealed a brain', async () => {
    mockResolveBrain.mockRejectedValueOnce(new NoBrainSealedError('inference_no_brain: nothing sealed'));

    const res = await POST(makeReq());

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'no_brain' }));
  });

  it('returns 422 no_model_selected — never a 500 — when a connected brain has no model chosen (#1769)', async () => {
    mockResolveBrain.mockRejectedValueOnce(
      new NoModelSelectedError('xAI is connected but no model is selected'),
    );

    const res = await POST(makeReq());

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'no_model_selected' }));
  });

  it('returns 422 model_deprecated when the selected model was retired upstream', async () => {
    mockResolveBrain.mockRejectedValueOnce(new ModelDeprecatedError('xai', 'grok-3'));

    const res = await POST(makeReq());

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'model_deprecated', connector: 'xai', modelId: 'grok-3' }));
  });

  it('returns 429 rate_limited on an exhausted upstream retry loop', async () => {
    mockForwardOpenAiCompatible.mockRejectedValueOnce(
      new RetryError({
        message: 'Failed after 3 attempts. Last error: Too Many Requests',
        reason: 'maxRetriesExceeded',
        errors: [new Error('Too Many Requests')],
      }),
    );

    const res = await POST(makeReq());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'rate_limited' }));
  });

  it('returns 503 credential_pending when the sealed credential is awaiting owner approval', async () => {
    mockResolveBrain.mockRejectedValueOnce(
      new VaultDelegationError('No active delegation grant', { field: 'xai-api-key:did:imajin:supplier', nodeDid: OWNER_DID }),
    );

    const res = await POST(makeReq());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'credential_pending' }));
  });

  it('returns 504 upstream_timeout when the upstream call times out', async () => {
    mockForwardOpenAiCompatible.mockRejectedValueOnce(new UpstreamTimeoutError('xai'));

    const res = await POST(makeReq());

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'upstream_timeout' }));
  });

  it('returns 502 upstream_unavailable when the upstream cannot be reached', async () => {
    mockForwardAnthropic.mockRejectedValueOnce(new UpstreamUnavailableError('anthropic', 'ECONNREFUSED'));
    mockResolveBrain.mockResolvedValueOnce(ANTHROPIC_BRAIN);

    const res = await POST(makeReq());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'upstream_unavailable' }));
  });

  it('returns 500 completions_failed for an unrecognized crash', async () => {
    mockResolveBrain.mockRejectedValueOnce(new Error('storage offline'));

    const res = await POST(makeReq());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'completions_failed' }));
  });

  it('returns 402 spend_cap_exceeded and never forwards when the connector cap is already reached (#1923)', async () => {
    mockEnforceSpendCap.mockRejectedValueOnce(
      new SpendCapExceededError('conn_real_row', { amountUsd: 10, period: 'daily' }, 12.5),
    );

    const res = await POST(makeReq());

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: 'spend_cap_exceeded', spentUsd: 12.5, capUsd: 10, period: 'daily' }),
    );
    expect(mockForwardOpenAiCompatible).not.toHaveBeenCalled();
    expect(mockForwardAnthropic).not.toHaveBeenCalled();
  });
});
