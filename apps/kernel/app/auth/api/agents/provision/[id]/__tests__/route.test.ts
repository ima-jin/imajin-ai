/**
 * Tests for GET/DELETE /auth/api/agents/provision/[id] (#1933).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, getProvisionMock, revokeProvisionMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  getProvisionMock: vi.fn(),
  revokeProvisionMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error }), { status: authError.status }),
}));
vi.mock('@/src/lib/auth/agent-provisioner', () => ({
  getProvision: getProvisionMock,
  revokeProvision: revokeProvisionMock,
}));

import { GET, DELETE } from '../route';

const OWNER = 'did:imajin:ryan';
const AGENT = 'did:imajin:agent-x';
const ENDPOINT = 'http://localhost:3000/auth/api/agents/provision/prov_1';

type RouteRequest = Parameters<typeof GET>[0];

function makeRequest(method: string): RouteRequest {
  return new Request(ENDPOINT, { method }) as unknown as RouteRequest;
}

function ctx(id = 'prov_1') {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /auth/api/agents/provision/[id]', () => {
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await GET(makeRequest('GET'), ctx());
    expect(res.status).toBe(401);
    expect(getProvisionMock).not.toHaveBeenCalled();
  });

  it('returns 500 for an unexpected error', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    getProvisionMock.mockRejectedValue(new Error('db exploded'));

    const res = await GET(makeRequest('GET'), ctx());
    expect(res.status).toBe(500);
  });

  it('returns 404 for an unknown provision', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    getProvisionMock.mockResolvedValue(null);

    const res = await GET(makeRequest('GET'), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is neither the serving DID nor the agent DID', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:stranger' } });
    getProvisionMock.mockResolvedValue({ id: 'prov_1', servingDid: OWNER, agentDid: AGENT });

    const res = await GET(makeRequest('GET'), ctx());
    expect(res.status).toBe(403);
  });

  it('returns the provision for the owning serving DID', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    getProvisionMock.mockResolvedValue({ id: 'prov_1', servingDid: OWNER, agentDid: AGENT });

    const res = await GET(makeRequest('GET'), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provision: { id: 'prov_1', servingDid: OWNER, agentDid: AGENT } });
  });

  it('returns the provision for the minted agent DID itself', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: AGENT } });
    getProvisionMock.mockResolvedValue({ id: 'prov_1', servingDid: OWNER, agentDid: AGENT });

    const res = await GET(makeRequest('GET'), ctx());
    expect(res.status).toBe(200);
  });
});

describe('DELETE /auth/api/agents/provision/[id]', () => {
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await DELETE(makeRequest('DELETE'), ctx());
    expect(res.status).toBe(401);
    expect(revokeProvisionMock).not.toHaveBeenCalled();
  });

  it('returns 500 for an unexpected error', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    revokeProvisionMock.mockRejectedValue(new Error('db exploded'));

    const res = await DELETE(makeRequest('DELETE'), ctx());
    expect(res.status).toBe(500);
  });

  it('propagates a lib-level error status', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    revokeProvisionMock.mockResolvedValue({ error: 'Only the owning DID may revoke this provision', status: 403 });

    const res = await DELETE(makeRequest('DELETE'), ctx());
    expect(res.status).toBe(403);
  });

  it('revokes on behalf of the authenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    revokeProvisionMock.mockResolvedValue({ revoked: true });

    const res = await DELETE(makeRequest('DELETE'), ctx());
    expect(res.status).toBe(200);
    expect(revokeProvisionMock).toHaveBeenCalledWith('prov_1', OWNER);
  });
});
