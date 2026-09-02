import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockResolveInferenceAuth, mockRateLimit, mockResolveBrain } = vi.hoisted(() => ({
  mockResolveInferenceAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockResolveBrain: vi.fn(),
}));

vi.mock('../../auth', () => ({ resolveInferenceAuth: mockResolveInferenceAuth }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://agent.example' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: mockRateLimit,
  getClientIP: () => '203.0.113.7',
}));

vi.mock('../../brain', async () => {
  const { createFakeBrainErrorClasses } = await import('../../__tests__/brain-errors-test-support');
  return { resolveBrain: mockResolveBrain, ...createFakeBrainErrorClasses() };
});

// `brain-http-errors.ts` (pulled in transitively by `route-support.ts`) imports
// `./spend-cap`, which imports the real `@/src/db` drizzle client. Fully
// replaced here, same as `chat/completions/route.test.ts` does, so this test
// never needs a live DATABASE_URL.
vi.mock('@/src/lib/inference/spend-cap', async () => {
  const { createFakeSpendCapClasses } = await import('../../__tests__/brain-errors-test-support');
  return createFakeSpendCapClasses();
});

import { guardAnthropicAuth, guardAnthropicRequest, mapAnthropicPipelineError, resolveAnthropicBrain, withCorsHeaders } from '../route-support';
import { NoBrainSealedError } from '../../brain';
import { UpstreamTimeoutError } from '../../completions/errors';

const OWNER_DID = 'did:imajin:supplier';
const APP_DID = 'did:imajin:nanoclaw-app';
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeRequest(body?: string): NextRequest {
  return new NextRequest('https://kernel.test/infer/v1/messages', { method: 'POST', body });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ limited: false });
  mockResolveInferenceAuth.mockResolvedValue({ ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID } });
});

describe('guardAnthropicAuth', () => {
  it('returns 429 when rate limited, before auth is checked', async () => {
    mockRateLimit.mockReturnValueOnce({ limited: true, retryAfter: 5 });

    const result = await guardAnthropicAuth(makeRequest());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.response.status).toBe(429);
    expect(mockResolveInferenceAuth).not.toHaveBeenCalled();
  });

  it('requests auth with the infer:completions scope', async () => {
    await guardAnthropicAuth(makeRequest());
    expect(mockResolveInferenceAuth).toHaveBeenCalledWith(expect.anything(), 'infer:completions');
  });

  it('propagates an auth failure with its own status and error', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: false, error: 'Invalid app token', status: 401 });

    const result = await guardAnthropicAuth(makeRequest());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({ error: 'Invalid app token' });
  });

  it('resolves ownerDid/appDid on success', async () => {
    const result = await guardAnthropicAuth(makeRequest());

    expect(result).toEqual({ ok: true, value: { cors: expect.any(Object), ownerDid: OWNER_DID, appDid: APP_DID } });
  });
});

describe('guardAnthropicRequest', () => {
  it('returns 400 when the body is empty', async () => {
    const result = await guardAnthropicRequest(makeRequest(''));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.response.status).toBe(400);
  });

  it('carries the body text through on success', async () => {
    const result = await guardAnthropicRequest(makeRequest('{"messages":[]}'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.bodyText).toBe('{"messages":[]}');
    expect(result.value.ownerDid).toBe(OWNER_DID);
  });

  it('short-circuits on an auth failure without reading the body', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: false, error: 'nope', status: 401 });

    const result = await guardAnthropicRequest(makeRequest('{"messages":[]}'));

    expect(result.ok).toBe(false);
  });
});

describe('resolveAnthropicBrain', () => {
  it('resolves onBehalfOf the principal, restricted to the anthropic connector', async () => {
    mockResolveBrain.mockResolvedValueOnce({ connector: 'anthropic' });

    await resolveAnthropicBrain(OWNER_DID, APP_DID);

    expect(mockResolveBrain).toHaveBeenCalledWith({ ownerDid: OWNER_DID, appDid: APP_DID }, { connectors: ['anthropic'] });
  });

  it('resolves by ownerDid alone when no appDid is given', async () => {
    mockResolveBrain.mockResolvedValueOnce({ connector: 'anthropic' });

    await resolveAnthropicBrain(OWNER_DID, undefined);

    expect(mockResolveBrain).toHaveBeenCalledWith(OWNER_DID, { connectors: ['anthropic'] });
  });
});

describe('withCorsHeaders', () => {
  it('attaches every provided header without altering status/body', () => {
    const response = new Response('{"ok":true}', { status: 201 });
    const result = withCorsHeaders(response, { 'X-Test': 'yes' });

    expect(result.status).toBe(201);
    expect(result.headers.get('X-Test')).toBe('yes');
  });
});

describe('mapAnthropicPipelineError', () => {
  it('maps a recognized brain error to its typed status', () => {
    const err = new NoBrainSealedError('inference_no_brain: nothing sealed');

    const res = mapAnthropicPipelineError(err, OWNER_DID, {}, fakeLogger, 'test-scope', { error: 'x_failed', message: 'X failed' });

    expect(res.status).toBe(422);
  });

  it('maps a recognized upstream error to its typed status', () => {
    const err = new UpstreamTimeoutError('anthropic');

    const res = mapAnthropicPipelineError(err, OWNER_DID, {}, fakeLogger, 'test-scope', { error: 'x_failed', message: 'X failed' });

    expect(res.status).toBe(504);
  });

  it('falls back to the given 500 shape for an unrecognized error', async () => {
    const res = mapAnthropicPipelineError(new Error('boom'), OWNER_DID, {}, fakeLogger, 'test-scope', {
      error: 'x_failed',
      message: 'X failed',
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'x_failed', message: 'X failed' }));
  });
});
