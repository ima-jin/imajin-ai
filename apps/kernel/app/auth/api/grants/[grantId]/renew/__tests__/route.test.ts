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
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(401);
    expect(renewGrantMock).not.toHaveBeenCalled();
  });

  it('renews with the default TTL when no body is supplied', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    renewGrantMock.mockResolvedValue({ grantId: GRANT_ID, expiresAt: '2026-09-01T00:00:00.000Z' });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(200);
    expect(renewGrantMock).toHaveBeenCalledWith({ grantId: GRANT_ID, requestedBy: DELEGATOR, ttlMs: undefined });
  });

  it('passes an explicit ttlMs through from the body', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    renewGrantMock.mockResolvedValue({ grantId: GRANT_ID, expiresAt: '2026-09-01T00:00:00.000Z' });

    await POST(makeRequest({ ttlMs: 60000 }), params());

    expect(renewGrantMock).toHaveBeenCalledWith({ grantId: GRANT_ID, requestedBy: DELEGATOR, ttlMs: 60000 });
  });

  it('surfaces a lib-level error with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    renewGrantMock.mockResolvedValue({ error: 'A revoked grant cannot be renewed — issue a new one', status: 409 });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(409);
  });
});
