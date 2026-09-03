/**
 * Tests for POST/GET /auth/api/agents/provision (#1933) — owner-direct-only
 * issuance, mirroring the `POST /auth/api/grants` auth rules (#1882).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, createProvisionMock, listProvisionsMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  createProvisionMock: vi.fn(),
  listProvisionsMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error, onboarding: 'https://imajin.ai/.well-known/agent.json' }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
  agentCardUrl: () => 'https://imajin.ai/.well-known/agent.json',
}));

const { ProvisionErrorMock } = vi.hoisted(() => {
  class ProvisionErrorMock extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { ProvisionErrorMock };
});
vi.mock('@/src/lib/auth/agent-provisioner', () => ({
  createProvision: createProvisionMock,
  listProvisions: listProvisionsMock,
  ProvisionError: ProvisionErrorMock,
}));

import { POST, GET } from '../route';

const OWNER = 'did:imajin:ryan';
const ENDPOINT = 'http://localhost:3000/auth/api/agents/provision';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(method: string, body?: unknown): RouteRequest {
  return new Request(ENDPOINT, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/api/agents/provision', () => {
  it('rejects a caller acting under X-Acting-For agent delegation', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:agent', actingFor: OWNER } });

    const res = await POST(makeRequest('POST', { servingDid: OWNER, name: 'Travel', harness: 'nanoclaw', placement: 'local', scopes: [] }));

    expect(res.status).toBe(403);
    expect(createProvisionMock).not.toHaveBeenCalled();
  });

  it('rejects a servingDid that does not match the caller\u2019s own effective DID', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });

    const res = await POST(makeRequest('POST', { servingDid: 'did:imajin:someone-else', name: 'Travel', harness: 'nanoclaw', placement: 'local', scopes: [] }));

    expect(res.status).toBe(403);
    expect(createProvisionMock).not.toHaveBeenCalled();
  });

  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeRequest('POST', { servingDid: OWNER, name: 'Travel', harness: 'nanoclaw', placement: 'local', scopes: [] }));

    expect(res.status).toBe(401);
    expect(createProvisionMock).not.toHaveBeenCalled();
  });

  it('rejects a request missing servingDid', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });

    const res = await POST(makeRequest('POST', { name: 'Travel', harness: 'nanoclaw', placement: 'local', scopes: [] }));

    expect(res.status).toBe(400);
    expect(createProvisionMock).not.toHaveBeenCalled();
  });

  it('rejects a request with a non-array scopes field', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });

    const res = await POST(makeRequest('POST', { servingDid: OWNER, name: 'Travel', harness: 'nanoclaw', placement: 'local', scopes: 'messages:write' }));

    expect(res.status).toBe(400);
    expect(createProvisionMock).not.toHaveBeenCalled();
  });

  it('creates a provision for the directly authenticated owner', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    createProvisionMock.mockResolvedValue({ id: 'prov_1', status: 'awaiting_boot' });

    const res = await POST(makeRequest('POST', { servingDid: OWNER, name: 'Travel', harness: 'nanoclaw', placement: 'hosted', scopes: ['messages:write'] }));

    expect(res.status).toBe(201);
    expect(createProvisionMock).toHaveBeenCalledWith(expect.objectContaining({ servingDid: OWNER, name: 'Travel', harness: 'nanoclaw', placement: 'hosted', scopes: ['messages:write'] }));
    expect(await res.json()).toEqual({ provision: { id: 'prov_1', status: 'awaiting_boot' } });
  });

  it('surfaces a lib-level ProvisionError with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    createProvisionMock.mockRejectedValue(new ProvisionErrorMock('Unknown grant capabilities requested: bogus:scope', 400));

    const res = await POST(makeRequest('POST', { servingDid: OWNER, name: 'Travel', harness: 'nanoclaw', placement: 'local', scopes: ['bogus:scope'] }));

    expect(res.status).toBe(400);
  });
});

describe('GET /auth/api/agents/provision', () => {
  it('lists provisions for the authenticated caller\u2019s own effective DID', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    listProvisionsMock.mockResolvedValue([{ id: 'prov_1' }]);

    const res = await GET(makeRequest('GET'));

    expect(listProvisionsMock).toHaveBeenCalledWith(OWNER);
    expect(await res.json()).toEqual({ provisions: [{ id: 'prov_1' }] });
  });
});
