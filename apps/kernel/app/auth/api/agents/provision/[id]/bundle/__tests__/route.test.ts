/**
 * Tests for GET /auth/api/agents/provision/[id]/bundle (#1933) — the
 * local-placement-only full file bundle download.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, getProvisionMock, renderEnvelopeForRowMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  getProvisionMock: vi.fn(),
  renderEnvelopeForRowMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error }), { status: authError.status }),
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
  getProvision: getProvisionMock,
  renderEnvelopeForRow: renderEnvelopeForRowMock,
  ProvisionError: ProvisionErrorMock,
}));

import { GET } from '../route';

const OWNER = 'did:imajin:ryan';
const ENDPOINT = 'http://localhost:3000/auth/api/agents/provision/prov_1/bundle';

type RouteRequest = Parameters<typeof GET>[0];

function makeRequest(): RouteRequest {
  return new Request(ENDPOINT) as unknown as RouteRequest;
}

function ctx(id = 'prov_1') {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /auth/api/agents/provision/[id]/bundle', () => {
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(401);
    expect(getProvisionMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown provision', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    getProvisionMock.mockResolvedValue(null);

    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not the owning serving DID', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:stranger' } });
    getProvisionMock.mockResolvedValue({ id: 'prov_1', servingDid: OWNER, placement: 'local' });

    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(403);
    expect(renderEnvelopeForRowMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a hosted-placement provision', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    getProvisionMock.mockResolvedValue({ id: 'prov_1', servingDid: OWNER, placement: 'hosted' });

    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(400);
    expect(renderEnvelopeForRowMock).not.toHaveBeenCalled();
  });

  it('returns the full rendered bundle for a local-placement provision owned by the caller', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    getProvisionMock.mockResolvedValue({ id: 'prov_1', servingDid: OWNER, placement: 'local' });
    renderEnvelopeForRowMock.mockReturnValue({
      harness: 'nanoclaw',
      files: [{ relativePath: 'envelope/SOUL.md', content: 'hello' }],
      manualSteps: ['Copy the channel adapter'],
    });

    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      harness: 'nanoclaw',
      files: [{ relativePath: 'envelope/SOUL.md', content: 'hello' }],
      manualSteps: ['Copy the channel adapter'],
    });
  });

  it('surfaces a lib-level ProvisionError with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    getProvisionMock.mockResolvedValue({ id: 'prov_1', servingDid: OWNER, placement: 'local', harness: 'openclaw' });
    renderEnvelopeForRowMock.mockImplementation(() => {
      throw new ProvisionErrorMock("harness 'openclaw' is not yet implemented", 501);
    });

    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(501);
  });

  it('returns 500 for an unexpected error', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
    getProvisionMock.mockRejectedValue(new Error('db exploded'));

    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(500);
  });
});
