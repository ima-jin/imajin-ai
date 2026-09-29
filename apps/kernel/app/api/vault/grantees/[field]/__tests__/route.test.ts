/**
 * Unit tests for GET /api/vault/grantees/[field] (#2450 step 1).
 *
 * Thin wrapper over `listOtherActiveGrantees` (shared with the server-side
 * guard on rotate/delete) — this test pins the route-level contract: auth,
 * and that the shared helper's result is passed through as-is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAdmin, mockListOtherActiveGrantees, mockGetNodeSigningIdentity } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
  mockListOtherActiveGrantees: vi.fn(),
  mockGetNodeSigningIdentity: vi.fn(() => ({ senderDid: 'did:imajin:node' })),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: mockGetNodeSigningIdentity }));
vi.mock('@/src/lib/vault/grantees', () => ({ listOtherActiveGrantees: mockListOtherActiveGrantees }));
vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

import { GET } from '../route.js';

function makeParams(field: string) {
  return { params: Promise.resolve({ field }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockGetNodeSigningIdentity.mockReturnValue({ senderDid: 'did:imajin:node' });
});

describe('GET /api/vault/grantees/[field]', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const response = await GET(new Request('http://localhost') as never, makeParams('warp-agent-key:did:imajin:x'));
    expect(response.status).toBe(401);
    expect(mockListOtherActiveGrantees).not.toHaveBeenCalled();
  });

  it('returns an empty list for a field with no other grantees', async () => {
    mockListOtherActiveGrantees.mockResolvedValue([]);
    const response = await GET(new Request('http://localhost') as never, makeParams('GH_TOKEN'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ field: 'GH_TOKEN', count: 0, grantees: [] });
    expect(mockListOtherActiveGrantees).toHaveBeenCalledWith('GH_TOKEN', 'did:imajin:node');
  });

  it('lists an external grantee with its purpose and expiry', async () => {
    mockListOtherActiveGrantees.mockResolvedValue([
      { grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null },
    ]);
    const response = await GET(
      new Request('http://localhost') as never,
      makeParams('internal-secret:kernel.attestation-internal-api-key'),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.grantees).toEqual([
      { grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null },
    ]);
  });

  it('surfaces a query failure as a 500', async () => {
    mockListOtherActiveGrantees.mockRejectedValue(new Error('db down'));
    const response = await GET(new Request('http://localhost') as never, makeParams('GH_TOKEN'));
    expect(response.status).toBe(500);
  });
});
