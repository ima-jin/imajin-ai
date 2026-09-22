/**
 * Unit tests for `requireMintAuthority` (#2242) — the shared auth gate for
 * POST /api/vault/mint and POST /api/vault/mint/revoke.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockGetNodeSigningIdentity } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetNodeSigningIdentity: vi.fn(),
}));

vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return {
    ...actual,
    requireAuth: mockRequireAuth,
    authErrorResponse: (authError: { error: string; status: number }) =>
      new Response(JSON.stringify({ error: authError.error }), { status: authError.status }),
  };
});

vi.mock('../sealing', () => ({
  getNodeSigningIdentity: mockGetNodeSigningIdentity,
}));

import { requireMintAuthority } from '../mint-authority.js';

const NODE_DID = 'did:imajin:node';
const OUTSIDER_DID = 'did:imajin:some-other-agent';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNodeSigningIdentity.mockReturnValue({ senderDid: NODE_DID, senderPubkey: 'pub', privateKeyHex: 'priv' });
});

describe('requireMintAuthority', () => {
  it('rejects with 401 when not authenticated', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const result = await requireMintAuthority(new Request('http://localhost/api/vault/mint'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('rejects with 403 an authenticated principal that is not the node identity', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: OUTSIDER_DID } });

    const result = await requireMintAuthority(new Request('http://localhost/api/vault/mint'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it('accepts the node identity itself', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: NODE_DID } });

    const result = await requireMintAuthority(new Request('http://localhost/api/vault/mint'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authority.actingDid).toBe(NODE_DID);
      expect(result.authority.composedBy).toBeNull();
    }
  });

  it('accepts an agent delegated to act for the node identity (actingFor), and records composedBy', async () => {
    mockRequireAuth.mockResolvedValue({
      identity: { id: OUTSIDER_DID, actingFor: NODE_DID },
    });

    const result = await requireMintAuthority(new Request('http://localhost/api/vault/mint'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authority.actingDid).toBe(NODE_DID);
      expect(result.authority.composedBy).toBe(OUTSIDER_DID);
    }
  });

  it('rejects an agent delegated to act for a DID that is not the node identity', async () => {
    mockRequireAuth.mockResolvedValue({
      identity: { id: OUTSIDER_DID, actingFor: 'did:imajin:someone-else' },
    });

    const result = await requireMintAuthority(new Request('http://localhost/api/vault/mint'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });
});
