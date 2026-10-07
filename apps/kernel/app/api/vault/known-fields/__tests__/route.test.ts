/**
 * Unit tests for GET /api/vault/known-fields (#2700).
 *
 * Authed with requireAuth (any authenticated identity), returns the registry
 * as `{ fields: [{ name, label, description, namespace }] }`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error }), { status: authError.status }),
}));

vi.mock('@/src/lib/vault/known-fields', () => ({
  KNOWN_VAULT_FIELDS: [
    { name: 'github-org-provisioning', label: 'GitHub org credential', description: 'stub', namespace: 'github' },
    { name: 'internal-secret:stub', label: 'Stub secret', description: 'stub', namespace: 'internal-secret' },
  ],
}));

import { GET } from '../route.js';

function makeRequest(): Request {
  return new Request('http://localhost/api/vault/known-fields');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: 'did:imajin:operator' } });
});

describe('GET /api/vault/known-fields', () => {
  it('returns 401 when not authenticated, without leaking the registry', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Authentication required', status: 401 });

    const response = await GET(makeRequest());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: 'Authentication required' });
    expect(body).not.toHaveProperty('fields');
  });

  it('passes the incoming request to requireAuth', async () => {
    const request = makeRequest();
    await GET(request);
    expect(mockRequireAuth).toHaveBeenCalledWith(request);
  });

  it('returns 200 with the known-fields registry when authenticated', async () => {
    const response = await GET(makeRequest());
    const body = (await response.json()) as { fields: unknown[] };

    expect(response.status).toBe(200);
    expect(body.fields).toEqual([
      { name: 'github-org-provisioning', label: 'GitHub org credential', description: 'stub', namespace: 'github' },
      { name: 'internal-secret:stub', label: 'Stub secret', description: 'stub', namespace: 'internal-secret' },
    ]);
  });

  it('shapes every field as { name, label, description, namespace } strings', async () => {
    const response = await GET(makeRequest());
    const body = (await response.json()) as { fields: Array<Record<string, unknown>> };

    expect(Object.keys(body)).toEqual(['fields']);
    for (const field of body.fields) {
      expect(Object.keys(field).sort()).toEqual(['description', 'label', 'name', 'namespace']);
      for (const value of Object.values(field)) {
        expect(typeof value).toBe('string');
      }
    }
  });
});
