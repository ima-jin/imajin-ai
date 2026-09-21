/**
 * Unit tests for GET /api/vault/delegation/grants (#2231).
 *
 * The agent's self-service view of its own vault_delegation_grants rows:
 * session/bearer-authenticated as the agent DID itself (not requireAdmin),
 * scoped strictly to the caller's own identity, and optionally narrowed by
 * `?purpose=`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockListGrantsForGrantee } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockListGrantsForGrantee: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error }), { status: authError.status }),
}));

vi.mock('@/src/lib/vault', () => ({
  listGrantsForGrantee: mockListGrantsForGrantee,
}));

vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from '../route.js';

const AGENT = 'did:imajin:gha-runner-agent';

function makeRequest(url: string): Request {
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: AGENT } });
  mockListGrantsForGrantee.mockResolvedValue([]);
});

describe('GET /api/vault/delegation/grants', () => {
  it('returns 401 when not authenticated', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });
    const response = await GET(makeRequest('http://localhost/api/vault/delegation/grants') as never);
    expect(response.status).toBe(401);
    expect(mockListGrantsForGrantee).not.toHaveBeenCalled();
  });

  it('lists grants scoped to the authenticated caller, not any DID in the query string', async () => {
    await GET(makeRequest('http://localhost/api/vault/delegation/grants') as never);
    expect(mockListGrantsForGrantee).toHaveBeenCalledWith({ granteeDid: AGENT, purpose: undefined });
  });

  it('passes the purpose filter through when present', async () => {
    await GET(makeRequest('http://localhost/api/vault/delegation/grants?purpose=gha-runner-registration') as never);
    expect(mockListGrantsForGrantee).toHaveBeenCalledWith({ granteeDid: AGENT, purpose: 'gha-runner-registration' });
  });

  it('returns the grants array from the library call', async () => {
    const grants = [{ grantId: 'vdg_1', purpose: 'gha-runner-registration' }];
    mockListGrantsForGrantee.mockResolvedValue(grants);

    const response = await GET(makeRequest('http://localhost/api/vault/delegation/grants') as never);
    const body = await response.json() as { grants: unknown[] };

    expect(response.status).toBe(200);
    expect(body.grants).toEqual(grants);
  });

  it('returns 500 when the library call throws', async () => {
    mockListGrantsForGrantee.mockRejectedValue(new Error('db down'));
    const response = await GET(makeRequest('http://localhost/api/vault/delegation/grants') as never);
    expect(response.status).toBe(500);
  });
});
