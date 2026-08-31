/**
 * Tests for DELETE /auth/api/grants/:grantId/capabilities/:capability —
 * revoke a single capability (#1882 item 4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, revokeGrantCapabilityMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  revokeGrantCapabilityMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error, onboarding: 'https://imajin.ai/.well-known/agent.json' }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));
vi.mock('@/src/lib/auth/grants', () => ({ revokeGrantCapability: revokeGrantCapabilityMock }));

import { DELETE } from '../route';

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
