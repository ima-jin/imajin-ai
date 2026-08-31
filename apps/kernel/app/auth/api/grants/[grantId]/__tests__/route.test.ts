/**
 * Tests for DELETE /auth/api/grants/:grantId — revoke an entire grant (#1882).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, revokeGrantMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  revokeGrantMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error, onboarding: 'https://imajin.ai/.well-known/agent.json' }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));
vi.mock('@/src/lib/auth/grants', () => ({ revokeGrant: revokeGrantMock }));

import { DELETE } from '../route';

const DELEGATOR = 'did:imajin:ryan';
const GRANT_ID = 'grant_1';

function makeRequest(): Request {
  return new Request(`http://localhost:3000/auth/api/grants/${GRANT_ID}`, { method: 'DELETE' });
}

function params() {
  return { params: Promise.resolve({ grantId: GRANT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DELETE /auth/api/grants/:grantId', () => {
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await DELETE(makeRequest(), params());

    expect(res.status).toBe(401);
    expect(revokeGrantMock).not.toHaveBeenCalled();
  });

  it('revokes using the directly authenticated identity as requestedBy', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    revokeGrantMock.mockResolvedValue({ revoked: true });

    const res = await DELETE(makeRequest(), params());

    expect(res.status).toBe(200);
    expect(revokeGrantMock).toHaveBeenCalledWith({ grantId: GRANT_ID, requestedBy: DELEGATOR });
  });

  it('sources requestedBy from actingAs', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:admin', actingAs: 'did:imajin:group' } });
    revokeGrantMock.mockResolvedValue({ revoked: true });

    await DELETE(makeRequest(), params());

    expect(revokeGrantMock).toHaveBeenCalledWith({ grantId: GRANT_ID, requestedBy: 'did:imajin:group' });
  });

  it('surfaces a lib-level error with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    revokeGrantMock.mockResolvedValue({ error: 'Only the delegator may revoke this grant', status: 403 });

    const res = await DELETE(makeRequest(), params());

    expect(res.status).toBe(403);
  });
});
