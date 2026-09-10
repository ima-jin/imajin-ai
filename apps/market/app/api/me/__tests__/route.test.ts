/**
 * Tests for apps/market/app/api/me/route.ts (GET)
 *
 * #2155: this route used to run a raw `getClient()` SQL query against the
 * kernel-owned profiles table directly to resolve a scope's display label.
 * It now calls the shared `resolveIdentitiesForDids` client (backed by the
 * profile service's batched `/api/resolve` route, #1998) instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveIdentitiesForDidsMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveActingDid: (identity: { actingAs?: string | null; id: string }) => identity.actingAs ?? identity.id,
  resolveIdentitiesForDids: mocks.resolveIdentitiesForDidsMock,
}));

vi.mock('@/lib/utils', () => ({
  jsonResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));

import { GET } from '../route';

function makeRequest(): Request {
  return new Request('https://market.test/api/me', { headers: { cookie: 'session=abc' } });
}

describe('GET /api/me — batched identity resolution (#1998/#2155)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveIdentitiesForDidsMock.mockResolvedValue(new Map());
  });

  it('returns did: null without resolving identities when not authenticated', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(json).toEqual({ did: null });
    expect(mocks.resolveIdentitiesForDidsMock).not.toHaveBeenCalled();
  });

  it('does not resolve identities when the caller is not acting as a scope', async () => {
    mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:user', actingAs: null } });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(json).toEqual({ did: 'did:imajin:user', scopeLabel: null });
    expect(mocks.resolveIdentitiesForDidsMock).not.toHaveBeenCalled();
  });

  it('resolves the scope display name via a single batched call', async () => {
    mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:user', actingAs: 'did:imajin:scope' } });
    mocks.resolveIdentitiesForDidsMock.mockResolvedValue(
      new Map([['did:imajin:scope', { did: 'did:imajin:scope', handle: 'scope-handle', displayName: 'Scope Name' }]]),
    );

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(mocks.resolveIdentitiesForDidsMock).toHaveBeenCalledWith(['did:imajin:scope']);
    expect(json).toEqual({ did: 'did:imajin:scope', scopeLabel: 'Scope Name' });
  });

  it('falls back to @handle when the scope has no display name', async () => {
    mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:user', actingAs: 'did:imajin:scope' } });
    mocks.resolveIdentitiesForDidsMock.mockResolvedValue(
      new Map([['did:imajin:scope', { did: 'did:imajin:scope', handle: 'scope-handle', displayName: null }]]),
    );

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(json.scopeLabel).toBe('@scope-handle');
  });

  it('returns a null scopeLabel when the scope has no resolved profile', async () => {
    mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:user', actingAs: 'did:imajin:scope' } });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(json.scopeLabel).toBeNull();
  });
});
