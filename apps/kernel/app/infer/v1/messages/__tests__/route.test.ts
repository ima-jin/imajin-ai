import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resetAnthropicRouteMocks,
  mockResolveBrain,
  mockReadConnectorRegistration,
  mockEnforceSpendCap,
  makeAnthropicPostRequest,
  OWNER_DID,
  APP_DID,
} from '../../__tests__/anthropic-route-test-support';

// Request-gating behavior (CORS pre-flight, rate limit, auth, empty body) is
// shared with `POST /infer/v1/messages/count_tokens` and tested once via
// `describe.each` in `../../__tests__/anthropic-post-routes-gating.test.ts` —
// this file covers only what is distinctive to `/infer/v1/messages` itself.
const { mockForwardAnthropicMessages } = vi.hoisted(() => ({ mockForwardAnthropicMessages: vi.fn() }));

vi.mock('@/src/lib/inference/anthropic-messages/forward', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/inference/anthropic-messages/forward')>(
    '@/src/lib/inference/anthropic-messages/forward',
  );
  return { ...actual, forwardAnthropicMessages: mockForwardAnthropicMessages };
});

import { POST } from '../route';
import { NoBrainSealedError, NoModelSelectedError } from '@/src/lib/inference/brain';
import { UpstreamTimeoutError } from '@/src/lib/inference/completions/errors';
import { SpendCapExceededError } from '@/src/lib/inference/spend-cap';

const makeReq = makeAnthropicPostRequest;

beforeEach(() => {
  resetAnthropicRouteMocks();
  mockForwardAnthropicMessages.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
});

describe('POST /infer/v1/messages — dispatch', () => {
  it('resolves the brain restricted to the anthropic connector, onBehalfOf the principal', async () => {
    await POST(makeReq());
    expect(mockResolveBrain).toHaveBeenCalledWith({ ownerDid: OWNER_DID, appDid: APP_DID }, { connectors: ['anthropic'] });
  });

  it('overrides the client-sent model with the sealed modelId before forwarding', async () => {
    await POST(makeReq({ body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [] }) }));

    const [, preparedBody] = mockForwardAnthropicMessages.mock.calls[0];
    expect(JSON.parse(preparedBody.value)).toMatchObject({ model: 'claude-opus-4-6' });
  });

  it('forwards session/turn headers as metering metadata', async () => {
    await POST(makeReq({ headers: { 'x-session-id': 'sess_1', 'x-turn-id': 'turn_1' } }));

    const [, , meta] = mockForwardAnthropicMessages.mock.calls[0];
    expect(meta).toEqual({ sessionId: 'sess_1', turnId: 'turn_1', agentDid: APP_DID });
  });

  it('forwards the anthropic-version and anthropic-beta request headers unchanged', async () => {
    await POST(makeReq({ headers: { 'anthropic-version': '2024-06-01', 'anthropic-beta': 'context-management-2025-06-27' } }));

    const [, , , headers] = mockForwardAnthropicMessages.mock.calls[0];
    expect(headers).toEqual({ anthropicVersion: '2024-06-01', anthropicBeta: 'context-management-2025-06-27' });
  });

  it('checks the spend cap on the credential-supplying connector before forwarding', async () => {
    mockReadConnectorRegistration.mockResolvedValueOnce({ id: 'conn_real_row', spendCap: { amountUsd: 10, period: 'daily' } });

    await POST(makeReq());

    expect(mockReadConnectorRegistration).toHaveBeenCalledWith(OWNER_DID, 'anthropic');
    expect(mockEnforceSpendCap).toHaveBeenCalledWith('conn_real_row', { amountUsd: 10, period: 'daily' });
  });

  it('attaches CORS headers to the adapter response without altering its body/status', async () => {
    mockForwardAnthropicMessages.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'msg_1' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://agent.example');
    expect(await res.json()).toEqual({ id: 'msg_1' });
  });

  it('never echoes the sealed key anywhere in the response', async () => {
    const res = await POST(makeReq());
    expect(await res.clone().text()).not.toContain('sk-ant-sealed-secret');
    expect(JSON.stringify(Array.from(res.headers.entries()))).not.toContain('sk-ant-sealed-secret');
  });
});

describe('POST /infer/v1/messages — pipeline outcomes', () => {
  it('returns 422 no_brain when no DID has sealed an Anthropic brain', async () => {
    mockResolveBrain.mockRejectedValueOnce(new NoBrainSealedError('inference_no_brain: nothing sealed'));

    const res = await POST(makeReq());

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'no_brain' }));
  });

  it('returns 422 no_model_selected when a connected Anthropic brain has no model chosen', async () => {
    mockResolveBrain.mockRejectedValueOnce(new NoModelSelectedError('Anthropic Claude is connected but no model is selected'));

    const res = await POST(makeReq());

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'no_model_selected' }));
  });

  it('returns 504 upstream_timeout when the upstream call times out', async () => {
    mockForwardAnthropicMessages.mockRejectedValueOnce(new UpstreamTimeoutError('anthropic'));

    const res = await POST(makeReq());

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'upstream_timeout' }));
  });

  it('returns 402 spend_cap_exceeded and never forwards when the connector cap is already reached', async () => {
    mockEnforceSpendCap.mockRejectedValueOnce(new SpendCapExceededError('conn_real_row', { amountUsd: 10, period: 'daily' }, 12.5));

    const res = await POST(makeReq());

    expect(res.status).toBe(402);
    expect(mockForwardAnthropicMessages).not.toHaveBeenCalled();
  });

  it('returns 500 messages_failed for an unrecognized crash', async () => {
    mockResolveBrain.mockRejectedValueOnce(new Error('storage offline'));

    const res = await POST(makeReq());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'messages_failed' }));
  });
});
