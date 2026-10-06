import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuthMock, createNodeUrlMock, appToken, APP_TOKEN_READ_ONLY, APP_TOKEN_WRITE_ONLY } from './media-auth-test-helpers';
import { mockIdentity, mockRequest } from './test-helpers';
import { patchAccess } from '../routes/access';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockDbWhere = vi.fn();

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
    update: vi.fn(() => ({ set: mockSet })),
  },
  assets: { id: 'id', ownerDid: 'owner_did', status: 'status', fairManifest: 'fair_manifest', fairPath: 'fair_path', fairDfosEventId: 'fair_dfos_event_id', createdAt: 'created_at', mimeType: 'mime_type' },
}));

const mockVerifyAppToken = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@imajin/auth', () => createAuthMock(mockVerifyAppToken));
vi.mock('@/src/lib/http/node-url', () => createNodeUrlMock());

vi.mock('@imajin/fair', () => ({
  isFairManifestV11: vi.fn((m: unknown) => !!(m && typeof m === 'object' && 'version' in m && (m as { version: string }).version === '1.1')),
}));

vi.mock('@/src/lib/media/manifest-helpers', () => ({
  updateManifestFlow: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: vi.fn(() => ({})),
  corsOptions: vi.fn(() => new Response(null, { status: 204 })),
}));

import { requireAuth } from '@imajin/auth';
import { updateManifestFlow } from '@/src/lib/media/manifest-helpers';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(body: unknown, url = 'https://test.imajin.ai/media/api/assets/asset_test/access', bearer?: string) {
  const req = mockRequest(body, url);
  if (bearer) req.headers.set('Authorization', `Bearer ${bearer}`);
  return req;
}

function setupAsset(overrides: Record<string, unknown> = {}) {
  const asset = {
    id: 'asset_test',
    ownerDid: 'did:imajin:owner',
    status: 'active',
    mimeType: 'image/png',
    fairManifest: {
      fair: '1.1',
      version: '1.1',
      access: { type: 'private' },
    },
    fairPath: '/mnt/media/test.fair.json',
    fairDfosEventId: 'evt_old',
    createdAt: new Date('2026-05-12T10:00:00Z'),
    metadata: {},
    ...overrides,
  };

  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue([asset]);

  mockSet.mockReturnValue({ where: mockDbWhere });
  mockDbWhere.mockResolvedValue(undefined);

  return asset;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyAppToken.mockResolvedValue(null);
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PATCH /media/api/assets/[id]/access', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await patchAccess(makeRequest({ access: 'public' }), 'asset_test');
    expect(res.status).toBe(401);
  });

  it('returns 400 when access is missing', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });

    const res = await patchAccess(makeRequest({}), 'asset_test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('access must be one of');
  });

  it('returns 400 when access is invalid', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });

    const res = await patchAccess(makeRequest({ access: 'super-secret' }), 'asset_test');
    expect(res.status).toBe(400);
  });

  it('returns 404 when asset not found', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    const res = await patchAccess(makeRequest({ access: 'public' }), 'missing');
    expect(res.status).toBe(404);
  });

  it('returns 403 when user does not own the asset', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity({ id: 'did:imajin:intruder' }) });
    setupAsset();

    const res = await patchAccess(makeRequest({ access: 'public' }), 'asset_test');
    expect(res.status).toBe(403);
  });

  it('updates access to public and runs manifest flow', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });
    const asset = setupAsset();
    const updatedAsset = { ...asset, fairManifest: { ...asset.fairManifest, access: { type: 'public' } } };

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    // Second db.select for returning updated asset
    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([updatedAsset]);

    vi.mocked(updateManifestFlow).mockResolvedValueOnce({
      signedManifest: updatedAsset.fairManifest as any,
      dfosEventId: 'evt_new',
    });

    const res = await patchAccess(makeRequest({ access: 'public' }), 'asset_test');
    expect(res.status).toBe(200);

    expect(updateManifestFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'asset_test',
        ownerDid: 'did:imajin:owner',
      }),
      expect.objectContaining({
        access: { type: 'public' },
      }),
      expect.any(String)
    );
  });

  it('updates access to conversation', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });
    const asset = setupAsset();
    const updatedAsset = { ...asset, fairManifest: { ...asset.fairManifest, access: { type: 'conversation' } } };

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([updatedAsset]);

    vi.mocked(updateManifestFlow).mockResolvedValueOnce({
      signedManifest: updatedAsset.fairManifest as any,
      dfosEventId: null,
    });

    const res = await patchAccess(makeRequest({ access: 'conversation' }), 'asset_test');
    expect(res.status).toBe(200);
  });

  it('handles missing manifest by creating a minimal v1.1 fallback', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });
    const asset = setupAsset({ fairManifest: {} });
    const updatedAsset = { ...asset };

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([updatedAsset]);

    vi.mocked(updateManifestFlow).mockResolvedValueOnce({
      signedManifest: {} as any,
      dfosEventId: null,
    });

    const res = await patchAccess(makeRequest({ access: 'public' }), 'asset_test');
    expect(res.status).toBe(200);
    const callArgs = vi.mocked(updateManifestFlow).mock.calls[0];
    expect(callArgs[1]).toMatchObject({
      fair: '1.1',
      version: '1.1',
      access: { type: 'public' },
    });
  });

  it('supports acting-as impersonation', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      identity: mockIdentity({ id: 'did:imajin:agent', actingAs: 'did:imajin:owner', actingAsRole: 'admin' }),
    });
    const asset = setupAsset();
    const updatedAsset = { ...asset, fairManifest: { ...asset.fairManifest, access: { type: 'public' } } };

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([updatedAsset]);

    vi.mocked(updateManifestFlow).mockResolvedValueOnce({
      signedManifest: updatedAsset.fairManifest as any,
      dfosEventId: 'evt_new',
    });

    const res = await patchAccess(makeRequest({ access: 'public' }), 'asset_test');
    expect(res.status).toBe(200);
  });

  // ─── #2535: scoped app-token auth ────────────────────────────────────────
  describe('app-token auth (#2535)', () => {
    function queueAsset() {
      const asset = setupAsset();
      const updatedAsset = { ...asset, fairManifest: { ...asset.fairManifest, access: { type: 'public' } } };

      mockFrom.mockReturnValueOnce({ where: mockWhere });
      mockWhere.mockReturnValueOnce({ limit: mockLimit });
      mockLimit.mockResolvedValueOnce([asset]);

      mockFrom.mockReturnValueOnce({ where: mockWhere });
      mockWhere.mockReturnValueOnce({ limit: mockLimit });
      mockLimit.mockResolvedValueOnce([updatedAsset]);

      vi.mocked(updateManifestFlow).mockResolvedValueOnce({
        signedManifest: updatedAsset.fairManifest as never,
        dfosEventId: 'evt_new',
      });
    }

    it('accepts a media:write app-token whose sub owns the asset', async () => {
      mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_WRITE_ONLY, 'did:imajin:owner'));
      queueAsset();

      const res = await patchAccess(makeRequest({ access: 'public' }, undefined, 'scoped-app-token'), 'asset_test');
      expect(res.status).toBe(200);
      expect(requireAuth).not.toHaveBeenCalled();
      expect(updateManifestFlow).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'asset_test', ownerDid: 'did:imajin:owner' }),
        expect.objectContaining({ access: { type: 'public' } }),
        expect.any(String)
      );
    });

    it('returns 403 for an app-token without media:write and never falls back to session auth', async () => {
      mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_READ_ONLY, 'did:imajin:owner'));

      const res = await patchAccess(makeRequest({ access: 'public' }, undefined, 'read-only-app-token'), 'asset_test');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Missing required scope: media:write');
      expect(requireAuth).not.toHaveBeenCalled();
      expect(updateManifestFlow).not.toHaveBeenCalled();
    });

    it('returns 403 when the app-token sub does not own the asset', async () => {
      mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_WRITE_ONLY, 'did:imajin:intruder'));
      setupAsset();

      const res = await patchAccess(makeRequest({ access: 'public' }, undefined, 'scoped-app-token'), 'asset_test');
      expect(res.status).toBe(403);
      expect(updateManifestFlow).not.toHaveBeenCalled();
    });

    it('falls through to session auth when the bearer is not a verifiable app-token', async () => {
      mockVerifyAppToken.mockResolvedValueOnce(null);
      vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

      const res = await patchAccess(makeRequest({ access: 'public' }, undefined, 'legacy-pat'), 'asset_test');
      expect(res.status).toBe(401);
      expect(requireAuth).toHaveBeenCalledTimes(1);
    });
  });
});
