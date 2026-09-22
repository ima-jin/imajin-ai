/**
 * Unit tests for GET /api/vault/mint/cards (#2247).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAdmin, mockListVaultKeyCards, mockListHandProvisionedFields } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockListVaultKeyCards: vi.fn(),
  mockListHandProvisionedFields: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock('@/src/lib/vault', () => ({
  listVaultKeyCards: mockListVaultKeyCards,
  listHandProvisionedFields: mockListHandProvisionedFields,
}));

vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from '../route.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/vault/mint/cards', () => {
  it('returns 401 for a non-admin caller', async () => {
    mockRequireAdmin.mockResolvedValue(false);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mockListVaultKeyCards).not.toHaveBeenCalled();
  });

  it('returns { keys, handProvisioned } for an admin caller', async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockListVaultKeyCards.mockResolvedValue([{ did: 'did:imajin:x' }]);
    mockListHandProvisionedFields.mockResolvedValue([{ field: 'GH_TOKEN:owner' }]);

    const response = await GET();
    const body = await response.json() as { keys: unknown[]; handProvisioned: unknown[] };

    expect(response.status).toBe(200);
    expect(body.keys).toEqual([{ did: 'did:imajin:x' }]);
    expect(body.handProvisioned).toEqual([{ field: 'GH_TOKEN:owner' }]);
  });

  it('returns a 500 vault error response when listing throws', async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockListVaultKeyCards.mockRejectedValue(new Error('db down'));

    const response = await GET();

    expect(response.status).toBe(500);
  });
});
