/**
 * Unit tests for POST /api/vault/delete (#2445 defect 5, #2450).
 *
 * A thin admin-gated wrapper over `deleteFromVault` — pins auth, validation,
 * the internal-secret:* refusal (#2450 DECISION a), the already-deleted 404
 * (peek, not get — a tombstone must not be re-tombstoned), the fail-closed
 * server-side grantee guard (#2450, closing the "browser-only, fails open"
 * gap the review found), and that every active grant on the field — the
 * node's own self-grant included — is revoked on a successful delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRequireAdmin,
  mockDeleteFromVault,
  mockEraseInactiveGrantKeyMaterial,
  mockVaultServicePeek,
  mockPublish,
  mockGetNodeSigningIdentity,
  mockListOtherActiveGrantees,
  mockDbUpdate,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
  mockDeleteFromVault: vi.fn(),
  mockEraseInactiveGrantKeyMaterial: vi.fn(async () => []),
  mockVaultServicePeek: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockGetNodeSigningIdentity: vi.fn(() => ({ senderDid: 'did:imajin:node' })),
  mockListOtherActiveGrantees: vi.fn(async () => []),
  mockDbUpdate: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));
vi.mock('@imajin/bus', () => ({ publish: mockPublish }));
vi.mock('@/src/lib/vault', () => ({
  deleteFromVault: mockDeleteFromVault,
  eraseInactiveGrantKeyMaterial: mockEraseInactiveGrantKeyMaterial,
  vaultService: { peek: mockVaultServicePeek },
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: mockGetNodeSigningIdentity }));
vi.mock('@/src/lib/vault/grantees', () => ({ listOtherActiveGrantees: mockListOtherActiveGrantees }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));
vi.mock('@/src/db', () => ({
  db: { update: mockDbUpdate },
  vaultDelegationGrants: {
    id: 'id',
    field: 'field',
    keyId: 'key_id',
    grantedTo: 'granted_to',
    status: 'status',
    revokedAt: 'revoked_at',
  },
}));

import { POST } from '../route.js';

function makeRequest(body?: unknown): Request {
  return new Request('http://localhost/api/vault/delete', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const TOMBSTONE = {
  field: 'warp-agent-key:did:imajin:abc123',
  cid: 'cid:tombstone',
  timestamp: '2026-09-29T00:00:00.000Z',
  senderDid: 'did:imajin:node',
};

function installUpdateReturning(rows: unknown[]) {
  mockDbUpdate.mockReturnValue({
    set: () => ({ where: () => ({ returning: () => Promise.resolve(rows) }) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockDeleteFromVault.mockResolvedValue(TOMBSTONE);
  mockPublish.mockResolvedValue(undefined);
  mockGetNodeSigningIdentity.mockReturnValue({ senderDid: 'did:imajin:node' });
  mockListOtherActiveGrantees.mockResolvedValue([]);
  mockVaultServicePeek.mockResolvedValue({ field: TOMBSTONE.field, deleted: false });
  mockEraseInactiveGrantKeyMaterial.mockResolvedValue([]);
  installUpdateReturning([]);
});

describe('POST /api/vault/delete', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const response = await POST(makeRequest({ field: 'GH_TOKEN' }) as never);
    expect(response.status).toBe(401);
    expect(mockDeleteFromVault).not.toHaveBeenCalled();
  });

  it('rejects a missing field', async () => {
    const response = await POST(makeRequest({}) as never);
    expect(response.status).toBe(400);
    expect(mockDeleteFromVault).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const response = await POST(new Request('http://localhost/api/vault/delete', { method: 'POST', body: '{' }) as never);
    expect(response.status).toBe(400);
  });

  describe('internal-secret:* refusal (#2450 DECISION a)', () => {
    it('refuses to delete an internal-secret:* field with a 409, before touching the vault', async () => {
      const response = await POST(makeRequest({ field: 'internal-secret:kernel.attestation-internal-api-key' }) as never);
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe('INTERNAL_SECRET_DELETE_REFUSED');
      expect(body.error).toContain('Rotate');
      expect(mockVaultServicePeek).not.toHaveBeenCalled();
      expect(mockDeleteFromVault).not.toHaveBeenCalled();
    });
  });

  describe('already-deleted (#2450)', () => {
    it('returns 404 for a field that never existed', async () => {
      mockVaultServicePeek.mockResolvedValue(undefined);
      const response = await POST(makeRequest({ field: 'GH_TOKEN' }) as never);
      expect(response.status).toBe(404);
      expect(mockDeleteFromVault).not.toHaveBeenCalled();
    });

    it('returns 404 — not 200 — for a field whose latest entry is already a tombstone', async () => {
      mockVaultServicePeek.mockResolvedValue({ field: 'GH_TOKEN', deleted: true });
      const response = await POST(makeRequest({ field: 'GH_TOKEN' }) as never);
      expect(response.status).toBe(404);
      expect(mockDeleteFromVault).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('fail-closed grantee guard (#2450)', () => {
    it('returns 409 with the count and list when there are other active grantees and no confirmField', async () => {
      mockListOtherActiveGrantees.mockResolvedValue([
        { grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null },
      ]);
      const response = await POST(makeRequest({ field: TOMBSTONE.field }) as never);
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.count).toBe(1);
      expect(body.grantees).toEqual([{ grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null }]);
      expect(mockDeleteFromVault).not.toHaveBeenCalled();
    });

    it('returns 409 when confirmField does not match the field exactly', async () => {
      mockListOtherActiveGrantees.mockResolvedValue([{ grantedTo: 'did:imajin:corpus', purpose: null, oneTime: false, expiresAt: null }]);
      const response = await POST(makeRequest({ field: TOMBSTONE.field, confirmField: 'wrong' }) as never);
      expect(response.status).toBe(409);
      expect(mockDeleteFromVault).not.toHaveBeenCalled();
    });

    it('proceeds when confirmField matches the field exactly', async () => {
      mockListOtherActiveGrantees.mockResolvedValue([{ grantedTo: 'did:imajin:corpus', purpose: null, oneTime: false, expiresAt: null }]);
      const response = await POST(makeRequest({ field: TOMBSTONE.field, confirmField: TOMBSTONE.field }) as never);
      expect(response.status).toBe(200);
      expect(mockDeleteFromVault).toHaveBeenCalledWith(TOMBSTONE.field);
    });

    it('never blocks a field with zero other grantees, confirmField or not', async () => {
      const response = await POST(makeRequest({ field: TOMBSTONE.field }) as never);
      expect(response.status).toBe(200);
      expect(mockDeleteFromVault).toHaveBeenCalledWith(TOMBSTONE.field);
    });
  });

  describe('grant revocation on success (#2450 defect 2)', () => {
    it('revokes every active grant on the field, including the self-grant, and erases their key material', async () => {
      installUpdateReturning([
        { id: 'vdg_1', field: TOMBSTONE.field, keyId: 'k1', grantedTo: 'did:imajin:node' },
        { id: 'vdg_2', field: TOMBSTONE.field, keyId: 'k2', grantedTo: 'did:imajin:corpus' },
      ]);
      mockListOtherActiveGrantees.mockResolvedValue([{ grantedTo: 'did:imajin:corpus', purpose: null, oneTime: false, expiresAt: null }]);

      const response = await POST(makeRequest({ field: TOMBSTONE.field, confirmField: TOMBSTONE.field }) as never);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.revokedGrantCount).toBe(2);
      expect(mockEraseInactiveGrantKeyMaterial).toHaveBeenCalledWith([
        { id: 'vdg_1', field: TOMBSTONE.field, keyId: 'k1', grantedTo: 'did:imajin:node' },
        { id: 'vdg_2', field: TOMBSTONE.field, keyId: 'k2', grantedTo: 'did:imajin:corpus' },
      ]);
      expect(mockPublish).toHaveBeenCalledWith(
        'vault.secret.deleted',
        expect.objectContaining({
          payload: expect.objectContaining({
            field: TOMBSTONE.field,
            revokedGrants: ['did:imajin:node', 'did:imajin:corpus'],
          }),
        }),
      );
    });
  });

  it('still succeeds when the bus publish fails (best-effort)', async () => {
    mockPublish.mockRejectedValue(new Error('bus down'));
    const response = await POST(makeRequest({ field: TOMBSTONE.field }) as never);
    expect(response.status).toBe(200);
  });

  it('surfaces a deleteFromVault failure via toVaultErrorResponse', async () => {
    mockDeleteFromVault.mockRejectedValue(new Error('boom'));
    const response = await POST(makeRequest({ field: TOMBSTONE.field }) as never);
    expect(response.status).toBe(400);
  });
});
