import { describe, it, expect, vi, beforeEach } from 'vitest';
import { patchGrants } from '../routes/grants';
import { mockIdentity, mockRequest } from './test-helpers';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockSet = vi.fn();
const mockDbWhere = vi.fn();

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
    update: vi.fn(() => ({ set: mockSet })),
  },
  assets: {},
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

function makeRequest(body: unknown, url = 'https://test.imajin.ai/media/api/assets/asset_test/grants') {
  return mockRequest(body, url);
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

describe('PATCH /media/api/assets/[id]/grants', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await patchGrants(makeRequest({ add: ['did:imajin:friend'] }), 'asset_test');
    expect(res.status).toBe(401);
  });

  it('returns 400 when add and remove are both empty', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });

    const res = await patchGrants(makeRequest({}), 'asset_test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('add or remove');
  });

  it('returns 404 when asset not found', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    const res = await patchGrants(makeRequest({ add: ['did:imajin:friend'] }), 'missing');
    expect(res.status).toBe(404);
  });

  it('returns 403 when user does not own the asset', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity({ id: 'did:imajin:intruder' }) });
    setupAsset();

    const res = await patchGrants(makeRequest({ add: ['did:imajin:friend'] }), 'asset_test');
    expect(res.status).toBe(403);
  });

  it('adds DIDs to allowedDids and switches to trust-graph', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });
    const asset = setupAsset();
    const updatedAsset = { ...asset };

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([updatedAsset]);

    vi.mocked(updateManifestFlow).mockResolvedValueOnce({
      signedManifest: {} as any,
      dfosEventId: 'evt_new',
    });

    const res = await patchGrants(
      makeRequest({ add: ['did:imajin:alice', 'did:imajin:bob'] }),
      'asset_test'
    );
    expect(res.status).toBe(200);

    const callArgs = vi.mocked(updateManifestFlow).mock.calls[0];
    expect(callArgs[1].access).toEqual({
      type: 'trust-graph',
      allowedDids: ['did:imajin:alice', 'did:imajin:bob'],
    });
  });

  it('merges add/remove with existing allowedDids, de-duping', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });
    const asset = setupAsset({
      fairManifest: {
        fair: '1.1',
        version: '1.1',
        access: { type: 'trust-graph', allowedDids: ['did:imajin:alice', 'did:imajin:charlie'] },
      },
    });

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    vi.mocked(updateManifestFlow).mockResolvedValueOnce({
      signedManifest: {} as any,
      dfosEventId: 'evt_new',
    });

    const res = await patchGrants(
      makeRequest({ add: ['did:imajin:bob', 'did:imajin:alice'], remove: ['did:imajin:charlie'] }),
      'asset_test'
    );
    expect(res.status).toBe(200);

    const callArgs = vi.mocked(updateManifestFlow).mock.calls[0];
    expect((callArgs[1].access as { allowedDids?: string[] }).allowedDids).toEqual(['did:imajin:alice', 'did:imajin:bob']);
  });

  it('removes all grants and keeps original access type when empty', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });
    const asset = setupAsset({
      fairManifest: {
        fair: '1.1',
        version: '1.1',
        access: { type: 'trust-graph', allowedDids: ['did:imajin:alice'] },
      },
    });

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    vi.mocked(updateManifestFlow).mockResolvedValueOnce({
      signedManifest: {} as any,
      dfosEventId: 'evt_new',
    });

    const res = await patchGrants(
      makeRequest({ remove: ['did:imajin:alice'] }),
      'asset_test'
    );
    expect(res.status).toBe(200);

    const callArgs = vi.mocked(updateManifestFlow).mock.calls[0];
    expect(callArgs[1].access).toEqual({
      type: 'trust-graph',
      allowedDids: undefined,
    });
  });

  it('filters non-string entries from add/remove arrays', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity() });
    const asset = setupAsset();

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    vi.mocked(updateManifestFlow).mockResolvedValueOnce({
      signedManifest: {} as any,
      dfosEventId: 'evt_new',
    });

    const res = await patchGrants(
      makeRequest({ add: ['did:imajin:alice', 123, null, 'did:imajin:bob'] }),
      'asset_test'
    );
    expect(res.status).toBe(200);

    const callArgs = vi.mocked(updateManifestFlow).mock.calls[0];
    expect((callArgs[1].access as { allowedDids?: string[] }).allowedDids).toEqual(['did:imajin:alice', 'did:imajin:bob']);
  });
});
