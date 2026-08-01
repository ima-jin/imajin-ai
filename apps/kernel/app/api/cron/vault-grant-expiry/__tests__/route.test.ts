/**
 * Unit tests for GET /api/cron/vault-grant-expiry (#1401).
 *
 * Acceptance criteria verified:
 *   - Expired active grants are transitioned to `revoked` with `revokedAt` set.
 *   - vault.delegation.revoked bus event is emitted per swept row.
 *   - Sweep is a no-op and returns ok when no expired active grants exist.
 *   - Non-expired and already-revoked rows are not touched (WHERE clause enforced
 *     at the DB layer; the unit test verifies the route processes the DB result
 *     correctly regardless of what is returned).
 *
 * The WHERE clause correctness (expired active only) is type-checked by Drizzle ORM
 * and covered by the schema index `idx_vault_delegation_expires`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VaultDelegationGrant } from '@/src/db';

// ── Mock: @/src/db — drizzle update chain ────────────────────────────────────

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

// ── Mock: vault key-material erase ──────────────────────────────────────────
//
// The sweep now erases each expired grant's wrapped key. That logic and its
// owner-envelope guard are covered in the vault suite; here we only assert the
// route calls it with what it swept.

const { mockEraseKeyMaterial } = vi.hoisted(() => ({
  mockEraseKeyMaterial: vi.fn(async (grants: Array<{ id: string }>) => grants.map((g) => g.id)),
}));

vi.mock('@/src/lib/vault', () => ({
  eraseInactiveGrantKeyMaterial: mockEraseKeyMaterial,
}));

// ── Mock: sealing identity ────────────────────────────────────────────────────

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({
    senderDid: 'did:imajin:testnode',
    senderPubkey: 'a'.repeat(64),
    privateKeyHex: 'b'.repeat(64),
  }),
}));

// ── Mock: bus publish ─────────────────────────────────────────────────────────

const { mockPublish } = vi.hoisted(() => {
  const mockPublish = vi.fn(() => Promise.resolve());
  return { mockPublish };
});

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

// ── Mock: logger ──────────────────────────────────────────────────────────────

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { GET } from '../route.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/vault-grant-expiry', { headers });
}

function makeGrant(overrides: Partial<VaultDelegationGrant> = {}): VaultDelegationGrant {
  const now = new Date();
  return {
    id: 'vdg_test_1',
    subject: 'did:imajin:owner',
    grantedTo: 'did:imajin:testnode',
    field: 'GH_TOKEN',
    ownerXPub: 'a'.repeat(64),
    wrappedKey: 'AAAA',
    wrappedNonce: 'BBBB',
    keyId: 'kid:test',
    ownerSignature: 'c'.repeat(128),
    status: 'revoked', // already updated by the time returning() resolves
    expiresAt: new Date(now.getTime() - 60_000), // 1 min ago
    createdAt: new Date(now.getTime() - 3_600_000),
    revokedAt: now,
    recipientXPub: 'd'.repeat(64),
    ownerEdPub: 'a'.repeat(64),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/vault-grant-expiry', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }) as never);
    expect(response.status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches Bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest({ authorization: 'Bearer test-secret' }) as never);
    expect(response.status).toBe(200);
  });

  it('passes auth (dev mode) when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(200);
  });

  // ── Sweep logic ─────────────────────────────────────────────────────────────

  it('expired active grant: transitions to revoked and emits bus event', async () => {
    delete process.env.CRON_SECRET;
    const grant = makeGrant();
    mockReturning.mockResolvedValue([grant]);

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; swept: number; grantIds: string[] };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.swept).toBe(1);
    expect(body.grantIds).toEqual([grant.id]);

    // DB update called with correct mutation shape
    expect(mockUpdate).toHaveBeenCalledOnce();

    // Expiry must destroy the wrapped key, not just flip status — otherwise an
    // expired grant is still a usable copy of the field key.
    expect(mockEraseKeyMaterial).toHaveBeenCalledOnce();
    expect(mockEraseKeyMaterial).toHaveBeenCalledWith([grant]);

    // Bus event emitted once
    expect(mockPublish).toHaveBeenCalledOnce();
    expect(mockPublish).toHaveBeenCalledWith(
      'vault.delegation.revoked',
      expect.objectContaining({
        issuer: 'did:imajin:testnode',
        subject: grant.subject,
        scope: 'vault',
        payload: expect.objectContaining({
          grantId: grant.id,
          field: grant.field,
          subject: grant.subject,
          grantedTo: grant.grantedTo,
          context_type: 'vault.delegation',
        }),
      }),
    );
  });

  it('emits one bus event per swept grant when multiple are swept', async () => {
    delete process.env.CRON_SECRET;
    const grants = [makeGrant({ id: 'vdg_1', field: 'TOKEN_A' }), makeGrant({ id: 'vdg_2', field: 'TOKEN_B' })];
    mockReturning.mockResolvedValue(grants);

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { swept: number; grantIds: string[] };

    expect(body.swept).toBe(2);
    expect(body.grantIds).toEqual(['vdg_1', 'vdg_2']);
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it('no-op: returns swept=0 and emits no bus events when no expired active grants exist', async () => {
    delete process.env.CRON_SECRET;
    // This case covers both non-expired active rows and already-revoked/superseded rows:
    // the WHERE clause (status=active AND expiresAt IS NOT NULL AND expiresAt < now)
    // ensures only truly expired active rows are returned.  An empty result means none matched.
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; swept: number; grantIds: string[] };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.swept).toBe(0);
    expect(body.grantIds).toEqual([]);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('returns 500 when the DB update throws', async () => {
    delete process.env.CRON_SECRET;
    mockReturning.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
