/**
 * Tests for DELETE /auth/api/grants/:grantId/capabilities/:capability —
 * revoke a single capability (#1882 item 4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, revokeGrantCapabilityMock, addGrantCapabilityMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  revokeGrantCapabilityMock: vi.fn(),
  addGrantCapabilityMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error, onboarding: 'https://imajin.ai/.well-known/agent.json' }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));
vi.mock('@/src/lib/auth/grants', () => ({
  revokeGrantCapability: revokeGrantCapabilityMock,
  addGrantCapability: addGrantCapabilityMock,
}));

import { DELETE, PUT } from '../route';

const DELEGATOR = 'did:imajin:ryan';
const GRANT_ID = 'grant_1';
const CAPABILITY = 'messages:write';

function makeRequest(): Request {
  return new Request(
    `http://localhost:3000/auth/api/grants/${GRANT_ID}/capabilities/${encodeURIComponent(CAPABILITY)}`,
    { method: 'DELETE' },
  );
}

function params(capability = CAPABILITY) {
  return { params: Promise.resolve({ grantId: GRANT_ID, capability: encodeURIComponent(capability) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DELETE /auth/api/grants/:grantId/capabilities/:capability', () => {
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await DELETE(makeRequest(), params());

    expect(res.status).toBe(401);
    expect(revokeGrantCapabilityMock).not.toHaveBeenCalled();
  });

  it('revokes the decoded capability using the directly authenticated identity', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    revokeGrantCapabilityMock.mockResolvedValue({ revoked: true });

    const res = await DELETE(makeRequest(), params());

    expect(res.status).toBe(200);
    expect(revokeGrantCapabilityMock).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      capability: CAPABILITY,
      requestedBy: DELEGATOR,
    });
  });

  it('surfaces a lib-level error with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    revokeGrantCapabilityMock.mockResolvedValue({ error: 'Only the delegator may revoke this grant', status: 403 });

    const res = await DELETE(makeRequest(), params());

    expect(res.status).toBe(403);
  });
});

function makePutRequest(): Request {
  return new Request(
    `http://localhost:3000/auth/api/grants/${GRANT_ID}/capabilities/${encodeURIComponent(CAPABILITY)}`,
    { method: 'PUT' },
  );
}

describe('PUT /auth/api/grants/:grantId/capabilities/:capability (#2108)', () => {
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await PUT(makePutRequest(), params());

    expect(res.status).toBe(401);
    expect(addGrantCapabilityMock).not.toHaveBeenCalled();
  });

  it('adds the decoded capability using the directly authenticated identity', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    addGrantCapabilityMock.mockResolvedValue({ added: true });

    const res = await PUT(makePutRequest(), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ added: true });
    expect(addGrantCapabilityMock).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      capability: CAPABILITY,
      requestedBy: DELEGATOR,
    });
  });

  it('reports added: false when the capability is already active (idempotent)', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    addGrantCapabilityMock.mockResolvedValue({ added: false });

    const res = await PUT(makePutRequest(), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ added: false });
  });

  it('surfaces unauthorized from a non-delegator caller with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:someone-else' } });
    addGrantCapabilityMock.mockResolvedValue({ error: 'Only the delegator may modify this grant', status: 403 });

    const res = await PUT(makePutRequest(), params());

    expect(res.status).toBe(403);
  });

  it('surfaces an invalid/unknown capability with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    addGrantCapabilityMock.mockResolvedValue({ error: 'Unknown capability: bogus:scope', status: 400 });

    const res = await PUT(makePutRequest(), params('bogus:scope'));

    expect(res.status).toBe(400);
  });
});
