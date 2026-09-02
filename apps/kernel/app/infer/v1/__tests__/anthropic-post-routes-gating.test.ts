/**
 * Request-gating tests shared by BOTH Anthropic Messages POST routes —
 * `POST /infer/v1/messages` and `POST /infer/v1/messages/count_tokens`
 * (#1959). Both routes call the exact same `guardAnthropicRequest` (rate
 * limit → auth → non-empty body) before doing anything route-specific, so
 * this gating behavior is tested once here via `describe.each` rather than
 * once per route file — each route's own test file then only covers its
 * distinctive dispatch/pipeline-outcome behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetAnthropicRouteMocks, mockResolveInferenceAuth, mockRateLimit, makeAnthropicPostRequest } from './anthropic-route-test-support';

const { mockForwardAnthropicMessages, mockForwardAnthropicCountTokens } = vi.hoisted(() => ({
  mockForwardAnthropicMessages: vi.fn(),
  mockForwardAnthropicCountTokens: vi.fn(),
}));

vi.mock('@/src/lib/inference/anthropic-messages/forward', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/inference/anthropic-messages/forward')>(
    '@/src/lib/inference/anthropic-messages/forward',
  );
  return {
    ...actual,
    forwardAnthropicMessages: mockForwardAnthropicMessages,
    forwardAnthropicCountTokens: mockForwardAnthropicCountTokens,
  };
});

import { POST as messagesPost, OPTIONS as messagesOptions } from '../messages/route';
import { POST as countTokensPost, OPTIONS as countTokensOptions } from '../messages/count_tokens/route';

beforeEach(() => {
  resetAnthropicRouteMocks();
  mockForwardAnthropicMessages.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  mockForwardAnthropicCountTokens.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
});

const cases: Array<[string, typeof messagesPost, typeof messagesOptions]> = [
  ['POST /infer/v1/messages', messagesPost, messagesOptions],
  ['POST /infer/v1/messages/count_tokens', countTokensPost, countTokensOptions],
];

describe.each(cases)('%s — request gating', (_label, POST, OPTIONS) => {
  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeAnthropicPostRequest());
    expect(res.status).toBe(204);
  });

  it('returns 429 when rate limited, before auth is even checked', async () => {
    mockRateLimit.mockReturnValueOnce({ limited: true, retryAfter: 12 });

    const res = await POST(makeAnthropicPostRequest());

    expect(res.status).toBe(429);
    expect(mockResolveInferenceAuth).not.toHaveBeenCalled();
  });

  it('returns 401 when auth fails (no bearer, no x-api-key)', async () => {
    mockResolveInferenceAuth.mockResolvedValueOnce({ ok: false, error: 'Invalid app token', status: 401 });

    const res = await POST(makeAnthropicPostRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid app token' });
  });

  it('requests auth with the infer:completions scope', async () => {
    await POST(makeAnthropicPostRequest());
    expect(mockResolveInferenceAuth).toHaveBeenCalledWith(expect.anything(), 'infer:completions');
  });

  it('returns 400 when the body is empty', async () => {
    const res = await POST(makeAnthropicPostRequest({ body: '' }));
    expect(res.status).toBe(400);
  });
});
