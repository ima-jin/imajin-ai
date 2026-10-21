/**
 * Tests for POST /auth/api/grants/:grantId/renew — extend a grant's lease (#1882).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, renewGrantMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  renewGrantMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error, onboarding: 'https://imajin.ai/.well-known/agent.json' }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));
vi.mock('@/src/lib/auth/grants', () => ({ renewGrant: renewGrantMock }));

import { POST } from '../route';

const DELEGATOR = 'did:imajin:ryan';
const GRANT_ID = 'grant_1';

function makeRequest(body?: unknown): Request {
  return new Request(`http://localhost:3000/auth/api/grants/${GRANT_ID}/renew`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params() {
  return { params: Promise.resolve({ grantId: GRANT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/api/grants/:grantId/renew', () => {
  it('uses the actual controller DID rather than trusting act-as context', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR, actingAs: 'did:imajin:group', actingAsRole: 'admin' } });
    renewGrantMock.mockResolvedValue({ grantId: GRANT_ID, expiresAt: '2026-09-01T00:00:00.000Z' });
    expect((await POST(makeRequest(), params())).status).toBe(200);
    expect(renewGrantMock).toHaveBeenCalledWith({ grantId: GRANT_ID, requestedBy: 'did:imajin:group', actorDid: DELEGATOR, ttlMs: undefined });
  });

  it('refuses agent delegation', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:agent', actingFor: DELEGATOR } });
    expect((await POST(makeRequest(), params())).status).toBe(403);
    expect(renewGrantMock).not.toHaveBeenCalled();
  });
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(401);
    expect(renewGrantMock).not.toHaveBeenCalled();
  });

  it('preserves the previous lease when no body is supplied', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    renewGrantMock.mockResolvedValue({ grantId: GRANT_ID, expiresAt: '2026-09-01T00:00:00.000Z' });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(200);
    expect(renewGrantMock).toHaveBeenCalledWith({ grantId: GRANT_ID, requestedBy: DELEGATOR, actorDid: DELEGATOR, ttlMs: undefined });
  });

  it('passes an explicit ttlMs through from the body', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    renewGrantMock.mockResolvedValue({ grantId: GRANT_ID, expiresAt: '2026-09-01T00:00:00.000Z' });

    await POST(makeRequest({ ttlMs: 60000 }), params());

    expect(renewGrantMock).toHaveBeenCalledWith({ grantId: GRANT_ID, requestedBy: DELEGATOR, actorDid: DELEGATOR, ttlMs: 60000 });
  });

  it.each([0, -1, '30d', null, Number.POSITIVE_INFINITY])('rejects invalid TTL %s without renewing', async (ttlMs) => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    expect((await POST(makeRequest({ ttlMs }), params())).status).toBe(400);
    expect(renewGrantMock).not.toHaveBeenCalled();
  });

  it.each([null, [], 'invalid'])('rejects a non-object body %s', async (body) => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    expect((await POST(makeRequest(body), params())).status).toBe(400);
    expect(renewGrantMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    const request = new Request('http://localhost/auth/api/grants/grant_1/renew', { method: 'POST', body: '{' });
    expect((await POST(request, params())).status).toBe(400);
    expect(renewGrantMock).not.toHaveBeenCalled();
  });

  it('surfaces a lib-level error with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    renewGrantMock.mockResolvedValue({ error: 'A revoked grant cannot be renewed — issue a new one', status: 409 });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(409);
  });
});
