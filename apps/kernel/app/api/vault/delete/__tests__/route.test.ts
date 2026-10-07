/**
 * Unit tests for DELETE /api/vault/delete (#2698, #2701).
 *
 * Pins the route-level contract: operator auth, validation, the
 * internal-secret:* refusal (400), 404 for a missing or already-tombstoned
 * field, the server-side grantee confirmation (count only, never values), and
 * that a successful delete reports every grant revoked by the atomic helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRequireAdmin,
  mockVaultServicePeek,
  mockDeleteSecretAndRevokeGrants,
  mockGetNodeSigningIdentity,
  mockListOtherActiveGrantees,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
  mockVaultServicePeek: vi.fn(),
  mockDeleteSecretAndRevokeGrants: vi.fn(),
  mockGetNodeSigningIdentity: vi.fn(() => ({ senderDid: 'did:imajin:node' })),
  mockListOtherActiveGrantees: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));
vi.mock('@/src/lib/vault', () => ({ vaultService: { peek: mockVaultServicePeek } }));
vi.mock('@/src/lib/vault/delete-secret', () => ({ deleteSecretAndRevokeGrants: mockDeleteSecretAndRevokeGrants }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: mockGetNodeSigningIdentity }));
vi.mock('@/src/lib/vault/grantees', () => ({ listOtherActiveGrantees: mockListOtherActiveGrantees }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

import { DELETE } from '../route.js';

function makeRequest(body?: unknown): Request {
  return new Request('http://localhost/api/vault/delete', {
    method: 'DELETE',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const FIELD = 'warp-agent-key:did:imajin:abc123';
const TOMBSTONE = { field: FIELD, cid: 'cid:tombstone', timestamp: '2026-10-07T00:00:00.000Z' };
const GRANTEE = { grantId: 'vdg_2', grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockVaultServicePeek.mockResolvedValue({ field: FIELD, deleted: false });
  mockGetNodeSigningIdentity.mockReturnValue({ senderDid: 'did:imajin:node' });
  mockListOtherActiveGrantees.mockResolvedValue([]);
  mockDeleteSecretAndRevokeGrants.mockResolvedValue({ tombstone: TOMBSTONE, revokedGrantees: ['did:imajin:node'] });
});

describe('DELETE /api/vault/delete — request validation', () => {
  it('returns 401 when not an operator', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const response = await DELETE(makeRequest({ field: FIELD }) as never);
    expect(response.status).toBe(401);
    expect(mockDeleteSecretAndRevokeGrants).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const response = await DELETE(new Request('http://localhost/api/vault/delete', { method: 'DELETE', body: '{' }) as never);
    expect(response.status).toBe(400);
  });

  it('rejects a JSON null body as a missing field', async () => {
    const response = await DELETE(makeRequest(null) as never);
    expect(response.status).toBe(400);
  });

  it.each([{}, { field: '' }, { field: '   ' }, { field: 42 }])('rejects a missing or empty field: %j', async (body) => {
    const response = await DELETE(makeRequest(body) as never);
    expect(response.status).toBe(400);
    expect(mockDeleteSecretAndRevokeGrants).not.toHaveBeenCalled();
  });

  it.each(['bad field!', 'a::b', 'a:', ':a', 'has/slash'])(
    'rejects a field outside the vault field grammar with a 400: %s',
    async (field) => {
      const response = await DELETE(makeRequest({ field }) as never);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/not a valid vault field name/);
      expect(mockVaultServicePeek).not.toHaveBeenCalled();
      expect(mockDeleteSecretAndRevokeGrants).not.toHaveBeenCalled();
    },
  );
});

describe('internal-secret:* refusal', () => {
  it('refuses with a 400 before touching the vault', async () => {
    const response = await DELETE(makeRequest({ field: 'internal-secret:kernel.attestation-internal-api-key' }) as never);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INTERNAL_SECRET_DELETE_REFUSED');
    expect(body.error).toContain('Rotate');
    expect(mockVaultServicePeek).not.toHaveBeenCalled();
    expect(mockDeleteSecretAndRevokeGrants).not.toHaveBeenCalled();
  });

  it('refuses even when the name only matches after trimming and even with confirmField', async () => {
    const field = 'internal-secret:kernel.x';
    const response = await DELETE(makeRequest({ field: `  ${field}  `, confirmField: field }) as never);
    expect(response.status).toBe(400);
    expect(mockDeleteSecretAndRevokeGrants).not.toHaveBeenCalled();
  });
});

describe('non-existent field', () => {
  it('returns 404 for a field that never existed', async () => {
    mockVaultServicePeek.mockResolvedValue(undefined);
    const response = await DELETE(makeRequest({ field: 'GH_TOKEN' }) as never);
    expect(response.status).toBe(404);
    expect(mockDeleteSecretAndRevokeGrants).not.toHaveBeenCalled();
  });

  it('returns 404 — not 200 — for a field whose latest entry is already a tombstone', async () => {
    mockVaultServicePeek.mockResolvedValue({ field: 'GH_TOKEN', deleted: true });
    const response = await DELETE(makeRequest({ field: 'GH_TOKEN' }) as never);
    expect(response.status).toBe(404);
    expect(mockDeleteSecretAndRevokeGrants).not.toHaveBeenCalled();
  });

  it('returns 404 when the field vanishes between the check and the transaction', async () => {
    mockDeleteSecretAndRevokeGrants.mockResolvedValue(undefined);
    const response = await DELETE(makeRequest({ field: FIELD }) as never);
    expect(response.status).toBe(404);
  });
});

describe('grantee warning', () => {
  it('returns 409 with the grantee COUNT — never the grantee list or any value — when no confirmField is sent', async () => {
    mockListOtherActiveGrantees.mockResolvedValue([GRANTEE, { ...GRANTEE, grantId: 'vdg_3', grantedTo: 'did:imajin:other' }]);
    const response = await DELETE(makeRequest({ field: FIELD }) as never);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.count).toBe(2);
    expect(body.code).toBe('GRANTEE_CONFIRMATION_REQUIRED');
    expect(body).not.toHaveProperty('grantees');
    expect(JSON.stringify(body)).not.toContain('did:imajin:corpus');
    expect(mockDeleteSecretAndRevokeGrants).not.toHaveBeenCalled();
  });

  it('returns 409 when confirmField does not match the field exactly', async () => {
    mockListOtherActiveGrantees.mockResolvedValue([GRANTEE]);
    const response = await DELETE(makeRequest({ field: FIELD, confirmField: 'wrong' }) as never);
    expect(response.status).toBe(409);
    expect(mockDeleteSecretAndRevokeGrants).not.toHaveBeenCalled();
  });

  it('proceeds when confirmField matches the field exactly', async () => {
    mockListOtherActiveGrantees.mockResolvedValue([GRANTEE]);
    const response = await DELETE(makeRequest({ field: FIELD, confirmField: FIELD }) as never);
    expect(response.status).toBe(200);
    expect(mockDeleteSecretAndRevokeGrants).toHaveBeenCalledWith(FIELD);
  });

  it('never blocks a field with no other grantees', async () => {
    const response = await DELETE(makeRequest({ field: FIELD }) as never);
    expect(response.status).toBe(200);
    expect(mockListOtherActiveGrantees).toHaveBeenCalledWith(FIELD, 'did:imajin:node');
  });
});

describe('happy path and grant revocation', () => {
  it('deletes the field and reports how many grants the transaction revoked', async () => {
    mockListOtherActiveGrantees.mockResolvedValue([GRANTEE]);
    mockDeleteSecretAndRevokeGrants.mockResolvedValue({
      tombstone: TOMBSTONE,
      revokedGrantees: ['did:imajin:node', 'did:imajin:corpus'],
    });

    const response = await DELETE(makeRequest({ field: `  ${FIELD}  `, confirmField: FIELD }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      field: FIELD,
      cid: TOMBSTONE.cid,
      timestamp: TOMBSTONE.timestamp,
      revokedGrantCount: 2,
    });
    expect(mockDeleteSecretAndRevokeGrants).toHaveBeenCalledTimes(1);
    expect(mockDeleteSecretAndRevokeGrants).toHaveBeenCalledWith(FIELD);
  });

  it('surfaces a transaction failure via toVaultErrorResponse', async () => {
    mockDeleteSecretAndRevokeGrants.mockRejectedValue(new Error('boom'));
    const response = await DELETE(makeRequest({ field: FIELD }) as never);
    expect(response.status).toBe(400);
  });
});
