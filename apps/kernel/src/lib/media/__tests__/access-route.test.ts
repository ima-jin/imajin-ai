import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn((identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id
  ),
}));

vi.mock('@imajin/fair', () => ({
  isFairManifestV1_1: vi.fn((m: unknown) => !!(m && typeof m === 'object' && 'version' in m && (m as { version: string }).version === '1.1')),
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

function makeRequest(body: unknown, url = 'https://test.imajin.ai/media/api/assets/asset_test/access') {
  return new Request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PATCH /media/api/assets/[id]/access', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await patchAccess(makeRequest({ access: 'public' }), 'asset_test');
    expect(res.status).toBe(401);
  });

  it('returns 400 when access is missing', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });

    const res = await patchAccess(makeRequest({}), 'asset_test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('access must be one of');
  });

  it('returns 400 when access is invalid', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });

    const res = await patchAccess(makeRequest({ access: 'super-secret' }), 'asset_test');
    expect(res.status).toBe(400);
  });

  it('returns 404 when asset not found', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    const res = await patchAccess(makeRequest({ access: 'public' }), 'missing');
    expect(res.status).toBe(404);
  });

  it('returns 403 when user does not own the asset', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:intruder', actingAs: undefined } });
    setupAsset();

    const res = await patchAccess(makeRequest({ access: 'public' }), 'asset_test');
    expect(res.status).toBe(403);
  });

  it('updates access to public and runs manifest flow', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
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
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
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
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
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
      identity: { id: 'did:imajin:agent', actingAs: 'did:imajin:owner', actingAsRole: 'admin' },
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
});
