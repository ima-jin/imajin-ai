import { describe, it, expect, vi, beforeEach } from 'vitest';
import { patchArticle } from '../routes/article';

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
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('@imajin/bus', () => ({
  publish: vi.fn(),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: vi.fn(() => ({})),
  corsOptions: vi.fn(() => new Response(null, { status: 204 })),
}));

import { requireAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { db } from '@/src/db';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(body: unknown, url = 'https://test.imajin.ai/media/api/assets/asset_test/article') {
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
    mimeType: 'text/markdown',
    fairManifest: {},
    fairPath: null,
    fairDfosEventId: null,
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

describe('PATCH /media/api/assets/[id]/article', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await patchArticle(makeRequest({ slug: 'hello', title: 'Hello' }), 'asset_test');
    expect(res.status).toBe(401);
  });

  it('returns 400 when slug is missing', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });

    const res = await patchArticle(makeRequest({ title: 'Hello' }), 'asset_test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('slug is required');
  });

  it('returns 400 when slug has underscores', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    const res = await patchArticle(makeRequest({ slug: 'hello_world', title: 'Hello' }), 'asset_test');
    expect(res.status).toBe(400);
  });

  it('returns 400 when slug has uppercase', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    const res = await patchArticle(makeRequest({ slug: 'Hello-World', title: 'Hello' }), 'asset_test');
    expect(res.status).toBe(400);
  });

  it('returns 400 when slug has spaces', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    const res = await patchArticle(makeRequest({ slug: 'hello world', title: 'Hello' }), 'asset_test');
    expect(res.status).toBe(400);
  });

  it('returns 400 when title is missing', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });

    const res = await patchArticle(makeRequest({ slug: 'hello' }), 'asset_test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('title is required');
  });

  it('returns 404 when asset not found', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    const res = await patchArticle(makeRequest({ slug: 'hello', title: 'Hello' }), 'missing');
    expect(res.status).toBe(404);
  });

  it('returns 403 when user does not own the asset', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:intruder', actingAs: undefined } });
    setupAsset();

    const res = await patchArticle(makeRequest({ slug: 'hello', title: 'Hello' }), 'asset_test');
    expect(res.status).toBe(403);
  });

  it('returns 400 when mime type is not text/markdown', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    setupAsset({ mimeType: 'image/png' });

    const res = await patchArticle(makeRequest({ slug: 'hello', title: 'Hello' }), 'asset_test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('text/markdown');
  });

  it('publishes article with defaults and emits bus event', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    const asset = setupAsset();
    const updatedAsset = { ...asset, metadata: { article: { slug: 'hello-world', title: 'Hello World', status: 'POSTED', date: '2026-05-12' } } };

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([updatedAsset]);

    const res = await patchArticle(
      makeRequest({ slug: 'hello-world', title: 'Hello World' }),
      'asset_test'
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.metadata).toEqual(updatedAsset.metadata);

    expect(publish).toHaveBeenCalledWith(
      'asset.article.published',
      expect.objectContaining({
        issuer: 'did:imajin:owner',
        subject: 'did:imajin:owner',
        scope: 'media',
        payload: expect.objectContaining({
          assetId: 'asset_test',
          slug: 'hello-world',
          title: 'Hello World',
          status: 'POSTED',
          date: expect.any(String),
        }),
      })
    );
  });

  it('accepts all optional fields', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    const asset = setupAsset();
    const updatedAsset = {
      ...asset,
      metadata: {
        article: {
          slug: 'deep-dive',
          title: 'A Deep Dive',
          subtitle: 'Subtitle here',
          description: 'Description here',
          status: 'REVIEW',
          date: '2026-06-01',
          order: 5,
        },
      },
    };

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([updatedAsset]);

    const res = await patchArticle(
      makeRequest({
        slug: 'deep-dive',
        title: 'A Deep Dive',
        subtitle: 'Subtitle here',
        description: 'Description here',
        status: 'REVIEW',
        date: '2026-06-01',
        order: 5,
      }),
      'asset_test'
    );
    expect(res.status).toBe(200);

    const setCall = vi.mocked(db.update).mock.calls;
    expect(setCall.length).toBeGreaterThan(0);
  });

  it('merges article block into existing metadata', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    const asset = setupAsset({ metadata: { source: 'editor', tags: ['tutorial'] } });
    const updatedAsset = { ...asset };

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([updatedAsset]);

    const res = await patchArticle(
      makeRequest({ slug: 'merged', title: 'Merged' }),
      'asset_test'
    );
    expect(res.status).toBe(200);

    const setCall = vi.mocked(db.update).mock.calls;
    expect(setCall.length).toBeGreaterThan(0);
  });

  it('supports acting-as impersonation', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      identity: { id: 'did:imajin:agent', actingAs: 'did:imajin:owner', actingAsRole: 'admin' },
    });
    const asset = setupAsset();
    const updatedAsset = { ...asset, metadata: { article: { slug: 'agent-post', title: 'Agent Post', status: 'POSTED', date: '2026-05-12' } } };

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([asset]);

    mockFrom.mockReturnValueOnce({ where: mockWhere });
    mockWhere.mockReturnValueOnce({ limit: mockLimit });
    mockLimit.mockResolvedValueOnce([updatedAsset]);

    const res = await patchArticle(
      makeRequest({ slug: 'agent-post', title: 'Agent Post' }),
      'asset_test'
    );
    expect(res.status).toBe(200);
  });
});
