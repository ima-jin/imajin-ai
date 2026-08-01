/**
 * Unit tests for POST /api/vault/delegation/revoke (#1521).
 *
 * The behaviour under test is the part that makes revocation mean something:
 * flipping `status` alone left the wrapped key in the row, so a revoked grant was
 * still a usable copy of the field key for anyone holding nodeXPriv and database
 * access. The route now erases the key material too.
 *
 * The erase itself, and its owner-envelope guard, are covered in the vault suite
 * (`src/lib/vault/__tests__/grant-leases.test.ts`). Here we assert the route calls
 * it with what it revoked, and reports honestly when it could not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VaultDelegationGrant } from '@/src/db';

// ── Mock: @/src/db — drizzle update chain ─────────────────────────────────────

const { mockReturning, mockUpdate } = vi.hoisted(() => {
  const mockReturning = vi.fn<() => Promise<VaultDelegationGrant[]>>();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  return { mockReturning, mockUpdate };
});

vi.mock('@/src/db', () => ({
  db: { update: mockUpdate },
  vaultDelegationGrants: {},
}));

// ── Mock: key-material erase ──────────────────────────────────────────────────

const { mockErase } = vi.hoisted(() => ({
  // Default: everything erased. Individual tests override to model a grant with
  // no owner envelope, which the real implementation refuses to erase.
  mockErase: vi.fn(async (grants: Array<{ id: string }>) => grants.map((g) => g.id)),
}));

vi.mock('@/src/lib/vault', () => ({ eraseInactiveGrantKeyMaterial: mockErase }));

// ── Mock: auth, sealing, bus, logger ──────────────────────────────────────────

const { mockRequireAdmin } = vi.hoisted(() => ({ mockRequireAdmin: vi.fn(async () => true) }));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({
    senderDid: 'did:imajin:testnode',
    senderPubkey: 'a'.repeat(64),
    privateKeyHex: 'b'.repeat(64),
  }),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn(() => Promise.resolve()) }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { POST } from '../route.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/vault/delegation/revoke', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function makeGrant(overrides: Partial<VaultDelegationGrant> = {}): VaultDelegationGrant {
  const now = new Date();
  return {
    id: 'vdg_test_1',
    subject: 'did:imajin:testnode',
    grantedTo: 'did:imajin:testnode',
    field: 'GH_TOKEN',
    ownerXPub: 'a'.repeat(64),
    wrappedKey: 'AAAA',
    wrappedNonce: 'BBBB',
    keyId: 'kid:test',
    ownerSignature: 'c'.repeat(128),
    status: 'revoked',
    expiresAt: null,
    createdAt: now,
    revokedAt: now,
    recipientXPub: 'd'.repeat(64),
    ownerEdPub: 'a'.repeat(64),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockErase.mockImplementation(async (grants: Array<{ id: string }>) => grants.map((g) => g.id));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/vault/delegation/revoke', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);

    const response = await POST(makeRequest({ field: 'GH_TOKEN' }) as never);
    expect(response.status).toBe(401);
  });

  it('returns 400 when field is missing', async () => {
    const response = await POST(makeRequest({}) as never);
    expect(response.status).toBe(400);
  });

  it('returns 404 when no active grant exists', async () => {
    mockReturning.mockResolvedValue([]);

    const response = await POST(makeRequest({ field: 'GH_TOKEN' }) as never);
    expect(response.status).toBe(404);
    // Nothing was revoked, so there is nothing to erase.
    expect(mockErase).not.toHaveBeenCalled();
  });

  it('erases key material for the revoked grant', async () => {
    const grant = makeGrant();
    mockReturning.mockResolvedValue([grant]);

    const response = await POST(makeRequest({ field: 'GH_TOKEN' }) as never);
    const body = await response.json() as {
      ok: boolean;
      revokedCount: number;
      keyMaterialErasedCount: number;
      grants: Array<{ id: string; keyMaterialErased: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.revokedCount).toBe(1);

    // Status alone would leave the wrapped key readable to anyone with nodeXPriv
    // and DB access — the erase is what actually withdraws access.
    expect(mockErase).toHaveBeenCalledOnce();
    expect(mockErase).toHaveBeenCalledWith([grant]);
    expect(body.keyMaterialErasedCount).toBe(1);
    expect(body.grants[0]!.keyMaterialErased).toBe(true);
  });

  it('reports honestly when key material could not be erased', async () => {
    // A pre-#1521 grant has no owner envelope, so the implementation refuses to
    // erase it — the wrapped key is still the only copy of the field key. The
    // response must not imply the credential was fully withdrawn.
    const grant = makeGrant();
    mockReturning.mockResolvedValue([grant]);
    mockErase.mockResolvedValue([]);

    const body = await (await POST(makeRequest({ field: 'GH_TOKEN' }) as never)).json() as {
      revokedCount: number;
      keyMaterialErasedCount: number;
      grants: Array<{ keyMaterialErased: boolean }>;
    };

    expect(body.revokedCount).toBe(1);
    expect(body.keyMaterialErasedCount).toBe(0);
    expect(body.grants[0]!.keyMaterialErased).toBe(false);
  });

  it('erases every revoked grant when several match', async () => {
    const grants = [
      makeGrant({ id: 'vdg_1' }),
      makeGrant({ id: 'vdg_2' }),
    ];
    mockReturning.mockResolvedValue(grants);

    const body = await (await POST(makeRequest({ field: 'GH_TOKEN' }) as never)).json() as {
      revokedCount: number;
      keyMaterialErasedCount: number;
    };

    expect(body.revokedCount).toBe(2);
    expect(body.keyMaterialErasedCount).toBe(2);
    expect(mockErase).toHaveBeenCalledWith(grants);
  });
});
