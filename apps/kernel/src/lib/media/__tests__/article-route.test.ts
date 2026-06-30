import { describe, it, expect, vi, beforeEach } from 'vitest';
import { patchArticle } from '../routes/article';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
  },
  assets: {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn((identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id
  ),
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

// patchArticle now persists frontmatter into the file via the shared content
// write path, then re-derives metadata.article from those bytes (#1193). We stub
// the file read + updateAssetContent rather than asserting a direct db.update.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('@/src/lib/media/update-asset', () => ({
  updateAssetContent: vi.fn(),
}));

import { requireAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { readFile } from 'node:fs/promises';
import { updateAssetContent } from '@/src/lib/media/update-asset';

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
    storagePath: '/mnt/media/did_imajin_owner/assets/asset_test.md',
    immutable: false,
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

  it('writes frontmatter, defaults status to DRAFT, and emits the bus event', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    const asset = setupAsset();
    const updated = {
      ...asset,
      metadata: { article: { slug: 'hello-world', title: 'Hello World', status: 'DRAFT', date: '2026-05-12' } },
    };
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: true, asset: updated } as never);

    const res = await patchArticle(makeRequest({ slug: 'hello-world', title: 'Hello World' }), 'asset_test');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.metadata).toEqual(updated.metadata);

    // The bytes handed to the shared write path carry YAML frontmatter, DRAFT by default.
    const writeArg = vi.mocked(updateAssetContent).mock.calls[0][0];
    expect(writeArg.assetId).toBe('asset_test');
    expect(writeArg.requesterDid).toBe('did:imajin:owner');
    expect(writeArg.requireTextMime).toBe(true);
    expect(writeArg.content).toContain('slug: "hello-world"');
    expect(writeArg.content).toContain('status: "DRAFT"');

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
          status: 'DRAFT',
          date: expect.any(String),
        }),
      })
    );
  });

  it('writes all supplied fields into the frontmatter and keeps an explicit status', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    const asset = setupAsset();
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: true, asset } as never);

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

    const writeArg = vi.mocked(updateAssetContent).mock.calls[0][0];
    expect(writeArg.content).toContain('slug: "deep-dive"');
    expect(writeArg.content).toContain('subtitle: "Subtitle here"');
    expect(writeArg.content).toContain('description: "Description here"');
    expect(writeArg.content).toContain('status: "REVIEW"');
    expect(writeArg.content).toContain('order: 5');
    expect(publish).toHaveBeenCalledWith(
      'asset.article.published',
      expect.objectContaining({ payload: expect.objectContaining({ status: 'REVIEW' }) })
    );
  });

  it('replaces stale frontmatter but preserves the existing file body', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    const asset = setupAsset();
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: true, asset } as never);
    vi.mocked(readFile).mockResolvedValueOnce('---\nslug: "old"\nstatus: "POSTED"\n---\n\n# Body kept' as never);

    const res = await patchArticle(makeRequest({ slug: 'merged', title: 'Merged' }), 'asset_test');
    expect(res.status).toBe(200);

    const writeArg = vi.mocked(updateAssetContent).mock.calls[0][0];
    expect(writeArg.content).toContain('slug: "merged"');
    expect(writeArg.content).not.toContain('slug: "old"');
    expect(writeArg.content).toContain('# Body kept');
  });

  it('maps a failed content write to an error status', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:owner', actingAs: undefined } });
    setupAsset();
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: false, code: 'storage_failed', message: 'File write failed' } as never);

    const res = await patchArticle(makeRequest({ slug: 'x', title: 'X' }), 'asset_test');
    expect(res.status).toBe(500);
  });

  it('supports acting-as impersonation (writes as the represented owner)', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      identity: { id: 'did:imajin:agent', actingAs: 'did:imajin:owner', actingAsRole: 'admin' },
    });
    const asset = setupAsset();
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: true, asset } as never);

    const res = await patchArticle(makeRequest({ slug: 'agent-post', title: 'Agent Post' }), 'asset_test');
    expect(res.status).toBe(200);
    expect(vi.mocked(updateAssetContent).mock.calls[0][0].requesterDid).toBe('did:imajin:owner');
  });
});
