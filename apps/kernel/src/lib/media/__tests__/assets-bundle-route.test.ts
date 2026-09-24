import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// POST /media/api/assets/bundle owns HTTP concerns only (auth, multipart
// parse, tier/size limits, MIME allowlist) — the materialize/rewrite pipeline
// itself is covered by bundle-upload.test.ts. These tests are about the
// request/response contract.

const mockProcessBundleUpload = vi.hoisted(() => vi.fn());
const mockIdentityLimit = vi.hoisted(() => vi.fn().mockResolvedValue([{ tier: 'soft', uploadLimitMb: 50 }]));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockIdentityLimit })) })),
    })),
  },
  identities: { id: 'id', tier: 'tier', uploadLimitMb: 'uploadLimitMb' },
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(async () => ({ identity: { id: 'did:imajin:owner', scope: 'actor' } })),
  resolveActingDid: vi.fn(() => 'did:imajin:owner'),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: vi.fn(() => ({ limited: false })),
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: vi.fn(() => ({})),
  corsOptions: vi.fn(() => new Response(null, { status: 204 })),
}));

vi.mock('@/src/lib/media/create-asset', () => ({
  inferMime: (browserMime: string, filename: string) =>
    browserMime && browserMime !== 'application/octet-stream'
      ? browserMime
      : filename.endsWith('.md')
        ? 'text/markdown'
        : 'application/octet-stream',
  isAllowedMime: () => true,
}));

vi.mock('@/src/lib/media/bundle-upload', () => ({
  processBundleUpload: mockProcessBundleUpload,
}));

import type { NextRequest } from 'next/server';
import { POST } from '@/app/media/api/assets/bundle/route';

// ─── Helpers ───────────────────────────────────────────────────────────────

function bundleRequest(opts: {
  index?: string;
  files: { name: string; content: string; type: string }[];
  indexAssetId?: string;
  strict?: string;
}): NextRequest {
  const form = new FormData();
  for (const f of opts.files) {
    form.append('files', new File([f.content], f.name, { type: f.type }), f.name);
  }
  if (opts.index) form.append('index', opts.index);
  if (opts.indexAssetId) form.append('indexAssetId', opts.indexAssetId);
  if (opts.strict !== undefined) form.append('strict', opts.strict);

  return new Request('https://test.imajin.ai/media/api/assets/bundle', {
    method: 'POST',
    body: form,
  }) as unknown as NextRequest;
}

const SUCCESS_RESULT = {
  ok: true as const,
  assets: [{ path: 'pic.png', id: 'asset_pic', url: 'https://node.example/media/api/assets/asset_pic', hash: 'h1' }],
  index: { id: 'asset_index', url: 'https://node.example/media/api/assets/asset_index' },
  rewritten: [{ from: './pic.png', to: 'https://node.example/media/api/assets/asset_pic' }],
  unresolved: [],
  articleWarning: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIdentityLimit.mockResolvedValue([{ tier: 'soft', uploadLimitMb: 50 }]);
  mockProcessBundleUpload.mockResolvedValue(SUCCESS_RESULT);
});

describe('POST /media/api/assets/bundle', () => {
  it('requires at least one file', async () => {
    const res = await POST(bundleRequest({ files: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at least one file/i);
    expect(mockProcessBundleUpload).not.toHaveBeenCalled();
  });

  it('auto-detects the index when exactly one markdown file is present', async () => {
    const res = await POST(
      bundleRequest({
        files: [
          { name: 'index.md', content: '![a](./pic.png)', type: 'text/markdown' },
          { name: 'pic.png', content: 'PNGDATA', type: 'image/png' },
        ],
      }),
    );

    expect(res.status).toBe(201);
    expect(mockProcessBundleUpload).toHaveBeenCalledWith(
      expect.objectContaining({ indexPath: 'index.md', ownerDid: 'did:imajin:owner', uploadedBy: 'did:imajin:owner' }),
    );
    const body = await res.json();
    expect(body.assets).toEqual(SUCCESS_RESULT.assets);
    expect(body.index).toEqual(SUCCESS_RESULT.index);
    expect(body.rewritten).toEqual(SUCCESS_RESULT.rewritten);
    expect('unresolved' in body).toBe(false); // omitted when empty
  });

  it('rejects with 400 when the index cannot be inferred (0 or 2+ markdown files, no `index` field)', async () => {
    const res = await POST(
      bundleRequest({
        files: [
          { name: 'a.png', content: 'A', type: 'image/png' },
          { name: 'b.png', content: 'B', type: 'image/png' },
        ],
      }),
    );

    expect(res.status).toBe(400);
    expect(mockProcessBundleUpload).not.toHaveBeenCalled();
  });

  it('uses the explicit `index` field when provided', async () => {
    await POST(
      bundleRequest({
        index: 'doc.md',
        files: [
          { name: 'doc.md', content: '![a](./pic.png)', type: 'text/markdown' },
          { name: 'readme.md', content: 'not the index', type: 'text/markdown' },
          { name: 'pic.png', content: 'PNGDATA', type: 'image/png' },
        ],
      }),
    );

    expect(mockProcessBundleUpload).toHaveBeenCalledWith(expect.objectContaining({ indexPath: 'doc.md' }));
  });

  it('forwards indexAssetId for update semantics', async () => {
    await POST(
      bundleRequest({
        files: [{ name: 'index.md', content: 'x', type: 'text/markdown' }],
        indexAssetId: 'asset_existing',
      }),
    );

    expect(mockProcessBundleUpload).toHaveBeenCalledWith(
      expect.objectContaining({ indexAssetId: 'asset_existing' }),
    );
  });

  it('includes unresolved refs in the response when present', async () => {
    mockProcessBundleUpload.mockResolvedValueOnce({ ...SUCCESS_RESULT, unresolved: ['./missing.png'] });

    const res = await POST(
      bundleRequest({ files: [{ name: 'index.md', content: 'x', type: 'text/markdown' }] }),
    );
    const body = await res.json();
    expect(body.unresolved).toEqual(['./missing.png']);
  });

  it('surfaces the article-frontmatter warning fields (#2282 item 6)', async () => {
    mockProcessBundleUpload.mockResolvedValueOnce({
      ...SUCCESS_RESULT,
      articleWarning: { warning: 'no frontmatter title', reason: 'missing_frontmatter', demotes: false },
    });

    const res = await POST(
      bundleRequest({ files: [{ name: 'index.md', content: 'x', type: 'text/markdown' }] }),
    );
    const body = await res.json();
    expect(body.warning).toBe('no frontmatter title');
    expect(body.articleProjection).toBeNull();
    expect(body.articleWarningReason).toBe('missing_frontmatter');
  });

  it('propagates a pipeline error status and message', async () => {
    mockProcessBundleUpload.mockResolvedValueOnce({ ok: false, status: 413, error: 'too big' });

    const res = await POST(
      bundleRequest({ files: [{ name: 'index.md', content: 'x', type: 'text/markdown' }] }),
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe('too big');
  });

  it('rejects a bundle exceeding the identity tier byte limit before calling the pipeline', async () => {
    mockIdentityLimit.mockResolvedValueOnce([{ tier: 'soft', uploadLimitMb: 0 }]);

    const res = await POST(
      bundleRequest({ files: [{ name: 'index.md', content: 'some content', type: 'text/markdown' }] }),
    );

    expect(res.status).toBe(413);
    expect(mockProcessBundleUpload).not.toHaveBeenCalled();
  });
});
