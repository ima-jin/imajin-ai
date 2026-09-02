import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resetAnthropicRouteMocks,
  mockResolveInferenceAuth,
  mockResolveBrain,
  OWNER_DID,
  APP_DID,
  ANTHROPIC_BRAIN,
} from '../../__tests__/anthropic-route-test-support';

const { mockForwardAnthropicModelsList } = vi.hoisted(() => ({ mockForwardAnthropicModelsList: vi.fn() }));

vi.mock('@/src/lib/inference/anthropic-messages/forward', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/inference/anthropic-messages/forward')>(
    '@/src/lib/inference/anthropic-messages/forward',
  );
  return { ...actual, forwardAnthropicModelsList: mockForwardAnthropicModelsList };
});

import { GET, OPTIONS } from '../route';

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(url = 'https://kernel.test/infer/v1/models'): RouteRequest {
  return { headers: new Headers(), url } as unknown as RouteRequest;
}

beforeEach(() => {
  resetAnthropicRouteMocks();
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
