/**
 * Unit tests for GET /api/vault/grantees/[field] (#2450 step 1).
 *
 * Pins the exclusion rules that make "N active grantees" honest: the node's
 * own self-grant is never counted, and neither is an expired or already-
 * consumed (one-time) grant — a Rotate/Delete warning about those would be
 * misleading, since they can't be used again regardless.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAdmin, mockDbSelect, mockGetNodeSigningIdentity } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
  mockDbSelect: vi.fn(),
  mockGetNodeSigningIdentity: vi.fn(() => ({ senderDid: 'did:imajin:node' })),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: mockGetNodeSigningIdentity }));
vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));
vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  vaultDelegationGrants: {
    grantedTo: 'granted_to',
    purpose: 'purpose',
    oneTime: 'one_time',
    expiresAt: 'expires_at',
    field: 'field',
    status: 'status',
    consumedAt: 'consumed_at',
  },
}));

import { GET } from '../route.js';

function makeParams(field: string) {
  return { params: Promise.resolve({ field }) };
}

function queryReturning(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  mockDbSelect.mockReturnValue(chain);
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
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('returns an empty list for a field with no other grantees', async () => {
    queryReturning([]);
    const response = await GET(new Request('http://localhost') as never, makeParams('GH_TOKEN'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ field: 'GH_TOKEN', count: 0, grantees: [] });
  });

  it('lists an external grantee with its purpose and expiry', async () => {
    queryReturning([
      { grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null },
    ]);
    const response = await GET(new Request('http://localhost') as never, makeParams('internal-secret:kernel.attestation-internal-api-key'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.grantees).toEqual([
      { grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null },
    ]);
  });

  it('surfaces a query failure as a 500', async () => {
    mockDbSelect.mockReturnValue({
      from: () => ({ where: () => Promise.reject(new Error('db down')) }),
    });
    const response = await GET(new Request('http://localhost') as never, makeParams('GH_TOKEN'));
    expect(response.status).toBe(500);
  });
});
