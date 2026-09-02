import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resetAnthropicRouteMocks,
  mockResolveInferenceAuth,
  mockResolveBrain,
  OWNER_DID,
  APP_DID,
} from '../../../__tests__/anthropic-route-test-support';

const { mockForwardAnthropicCountTokens } = vi.hoisted(() => ({ mockForwardAnthropicCountTokens: vi.fn() }));

vi.mock('@/src/lib/inference/anthropic-messages/forward', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/inference/anthropic-messages/forward')>(
    '@/src/lib/inference/anthropic-messages/forward',
  );
  return { ...actual, forwardAnthropicCountTokens: mockForwardAnthropicCountTokens };
});

import { POST, OPTIONS } from '../route';
import { NoBrainSealedError } from '@/src/lib/inference/brain';

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(opts: { headers?: Record<string, string>; body?: string } = {}): RouteRequest {
  return {
    headers: new Headers(opts.headers ?? {}),
    text: async () => opts.body ?? JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  } as unknown as RouteRequest;
}

beforeEach(() => {
  resetAnthropicRouteMocks();
  mockForwardAnthropicCountTokens.mockResolvedValue(
    new Response(JSON.stringify({ input_tokens: 14 }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
});

describe('POST /infer/v1/messages/count_tokens', () => {
  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });

  it('returns 401 without a valid bearer or x-api-key', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: false, error: 'Invalid app token', status: 401 });

    const res = await POST(makeReq());

    expect(res.status).toBe(401);
  });

  it('requests auth with the infer:completions scope', async () => {
    await POST(makeReq());
    expect(mockResolveInferenceAuth).toHaveBeenCalledWith(expect.anything(), 'infer:completions');
  });

  it('resolves the brain restricted to the anthropic connector and forwards the count_tokens call unmetered', async () => {
    const res = await POST(makeReq());

    expect(mockResolveBrain).toHaveBeenCalledWith({ ownerDid: OWNER_DID, appDid: APP_DID }, { connectors: ['anthropic'] });
    expect(mockForwardAnthropicCountTokens).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 14 });
  });

  it('overrides the client-sent model with the sealed modelId', async () => {
    await POST(makeReq({ body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [] }) }));

    const [, bodyValue] = mockForwardAnthropicCountTokens.mock.calls[0];
    expect(JSON.parse(bodyValue)).toMatchObject({ model: 'claude-opus-4-6' });
  });

  it('returns 422 no_brain when no DID has sealed an Anthropic brain', async () => {
    mockResolveBrain.mockRejectedValueOnce(new NoBrainSealedError('inference_no_brain: nothing sealed'));

    const res = await POST(makeReq());

    expect(res.status).toBe(422);
  });

  it('returns 400 when the body is empty', async () => {
    const res = await POST(makeReq({ body: '' }));
    expect(res.status).toBe(400);
  });
});
