/**
 * Tests for POST /auth/api/knock (#1883) — public submission endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { submitKnockMock, rateLimitMock } = vi.hoisted(() => ({
  submitKnockMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock('@/src/lib/auth/knock', () => ({ submitKnock: submitKnockMock }));
vi.mock('@imajin/config', () => ({
  rateLimit: rateLimitMock,
  getClientIP: () => '203.0.113.1',
}));

import { POST } from '../route';

const ENDPOINT = 'http://localhost:3000/auth/api/knock';
type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(body?: unknown): RouteRequest {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as RouteRequest;
}

const VALID_BODY = {
  publicKey: 'a'.repeat(64),
  declared_target: 'did:imajin:ryan',
  self_description: 'A matchmaking agent for professional intros.',
  requested_capabilities: ['intros:propose'],
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockReturnValue({ limited: false, retryAfter: 0 });
});

describe('POST /auth/api/knock', () => {
  it('rejects when the per-IP rate limit is exceeded', async () => {
    rateLimitMock.mockReturnValueOnce({ limited: true, retryAfter: 30 });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(429);
    expect(submitKnockMock).not.toHaveBeenCalled();
  });

  it('rejects when the per-target rate limit is exceeded', async () => {
    rateLimitMock
      .mockReturnValueOnce({ limited: false, retryAfter: 0 }) // IP check
      .mockReturnValueOnce({ limited: true, retryAfter: 60 }); // target check

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(429);
    expect(submitKnockMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const res = await POST(new Request(ENDPOINT, { method: 'POST', body: '{not json' }) as unknown as RouteRequest);
    expect(res.status).toBe(400);
  });

  it('passes snake_case fields through to submitKnock', async () => {
    submitKnockMock.mockResolvedValue({ knock: { knockId: 'knock_1', status: 'pending' } });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(201);
    expect(submitKnockMock).toHaveBeenCalledWith({
      publicKey: VALID_BODY.publicKey,
      declaredTarget: VALID_BODY.declared_target,
      selfDescription: VALID_BODY.self_description,
      requestedCapabilities: VALID_BODY.requested_capabilities,
      externalDid: undefined,
    });
  });

  it('also accepts camelCase field aliases', async () => {
    submitKnockMock.mockResolvedValue({ knock: { knockId: 'knock_1', status: 'pending' } });

    const res = await POST(makeRequest({
      publicKey: VALID_BODY.publicKey,
      declaredTarget: VALID_BODY.declared_target,
      selfDescription: VALID_BODY.self_description,
      requestedCapabilities: VALID_BODY.requested_capabilities,
      externalDid: 'did:web:boardy.ai',
    }));

    expect(res.status).toBe(201);
    expect(submitKnockMock).toHaveBeenCalledWith(expect.objectContaining({
      declaredTarget: VALID_BODY.declared_target,
      externalDid: 'did:web:boardy.ai',
    }));
  });

  it('surfaces a lib-level validation error with its own status code', async () => {
    submitKnockMock.mockResolvedValue({ error: 'declared_target does not resolve to an existing principal', status: 404 });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(404);
  });
});
